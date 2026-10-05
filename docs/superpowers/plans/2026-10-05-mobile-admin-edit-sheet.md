# Mobile Admin Edit Sheet and Note Sheet (lane ma-e3-edit-sheet) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the phone event detail, "Edit details" opens a bottom sheet that edits an upcoming event's date, start time, duration and guest count and saves them through the desktop editor's own path, showing the repriced total and the desktop's notify step; a new "Note" row edits the internal booking note.

**Architecture:** No server change. The pieces of the desktop editor the phone needs that still live inside `ProposalEditorForm.js` (bartender-override detection, the preview request body, the stored gratuity, the mandate lock, the class-package gate) and inside `NotifyConfirmModal.jsx` (draft seeding, the notify payload, the per-channel outcome toasts) move into two shared modules, `proposalEditor/editorCore.js` and `comms/notifyDrafts.js`; the desktop then calls them with its behaviour unchanged except one new reprice line (the automatic gratuity email). The phone gets one pure view-model (`utils/editSheetView.js`), one hook that does every read and write (`components/mobile/useEditSheet.js`), and two sheets (`EditSheet.js`, `NoteSheet.js`) built from the assignment sheet's existing vocabulary. `EventDetailPhone` mounts them through the push-history drawer param, so Android Back closes a sheet and stays on the page.

**Tech Stack:** React 18 + react-router 6.30, jest + RTL 13 (jest-dom imported per file, CRA `resetMocks: true`), the existing `api` client (axios), `playwright-core` with the bundled Chromium for the phone-viewport gate. Server endpoints are used as they are.

**Spec:** `docs/superpowers/specs/2026-08-13-mobile-admin-design.md`: section 3 "Brainstorm decisions of 2026-10-05" (the contract for this lane), section 3 Visual contract and the decision lists before it, section 4 Detail (structured edits), section 7 Offline (money sheets never open from a stored copy, writes never queue), section 10 (inline failures), section 11 (per-screen gate).

**Benchmark (Visual contract):** `docs/design-artifacts/2026-09-15-mobile-admin-shell.dc.html`. Edit details row: the `m-more-row` with `editLocked` / `editUnlocked` (trailing "needs connection" with the amber dot, or "date · time · guests" with a right arrow). Edit sheet: the block under `hasEditSheet` (head "<client> · <kind>" over the mono note `eSheetNote`; rows Date with the calendar icon and an arrow, Start with the clock icon and an arrow, Duration with a stepper, Setup, Guests with a stepper; "New total" with old → new; the right-aligned balance note; Cancel and the primary button `eConfirmLabel`). Logic: `onEditConfirm` and the `ed = {...}` block (`eSheetNote: 'event edit · reprices the booking'`, `eBalNote: 'balance due becomes ' + fmt(Math.max(0, newTotalN - paidN))`, `eConfirmLabel: repriced ? 'Confirm new total' : 'Done'`). The event variant shows no Bartenders and no add-ons (`eShowBars: isProp`). Stepper CSS source: `docs/design-artifacts/_ds/dr-bartender-os-design-system-72035042-c993-47e2-9dc8-c452b7bf5fa4/components-mobile.css:216-253` (`.m-stepper-ctl`, `.m-stepper-btn`, `.m-stepper-value`). The note sheet and the notify step are not drawn; they are built from the drawn sheet's own parts (see Decisions). It renders locally: `cd docs/design-artifacts && python3 -m http.server 8765`, headless Chromium at 460x960 on `http://127.0.0.1:8765/2026-09-15-mobile-admin-shell.dc.html` (the runtime loads React from unpkg, so the box needs network). **Freshness:** the repo snapshot was byte-identical to the live design file on 2026-09-28 (ma-e2 plan). The DesignSync tool reads the live file only inside a `/design-sync` session Dallas starts, so the lane opens by asking him whether `Phone Admin Shell.dc.html` changed since 2026-09-15; if it did, he starts `/design-sync`, the orchestrator byte-compares, and any change is folded into this plan on main before Task 3.

**Scope:** Lane ma-e3-edit-sheet only, as declared in `docs/superpowers/plans/2026-09-15-mobile-admin-events-list.md` (Lane map). The proposal variant of the sheet (Bartenders and add-on steppers) is ma-f2. Not touched: the server, the service worker, the desktop editor's own layout, the assignment sheet.

**Proven context (verified against main on 2026-10-05, not from memory):**
- `server/routes/proposals/crud.js` (997 lines, sensitive-listed, NOT touched): `PATCH /:id` `:325`, `auth, requireAdminOrManager`, row locked `FOR UPDATE`; absent `addon_ids` deletes every `proposal_addons` row and absent `addon_quantities` defaults each to 1 (`:405`, `:411`, `:657`); absent `num_bartenders` recomputes from the ratio (`:540`, `:580`); date and start are `COALESCE` (`:555-556`); `setup_minutes_before` and `class_options` are written as sent (`$23`, `$25`), so they must be sent as stored; venue validation and `event_location` recomposition run only when a venue key is present (`:374-388`, `venueAddress.js:128-141` `resolvePendingLocation` returns null when none is); curfew: when date, start or duration is in the body and the end passes the curfew, it throws `ValidationError({ event_duration_hours: <message>, past_curfew: 'true' })` (`:443-463`) unless `acknowledge_past_curfew`; the response is `{ ...updatedRow, notifications }` (`:956`); the gratuity staffing-change email is sent post-commit when `amount_paid > 0`, `gratuity_rate_change_origin !== 'admin'` and the snapshot's `gratuity.total` rose (`:531-551`, `:849-882`, `server/utils/gratuityMandate.js:58-65` `staffingGratuityOrigin`). No Stripe call anywhere on this path.
- `server/routes/proposals/patchContractHours.js:24` `PENDING_MESSAGE`; a duration change while a service extension is pending throws `ValidationError({ event_duration_hours: PENDING_MESSAGE })` (`:38-50`). `server/utils/proposalRules.js:74`: a hosted package under 25 guests throws on `guest_count`. `server/utils/errors.js:11-14`: a `ValidationError`'s message is "Please fix the errors below"; the reason is in `fieldErrors`. `client/src/utils/api.js` rejects with `{ message, code, fieldErrors, status }`, and with `status: 0, code: 'NETWORK_ERROR'` on a transport failure.
- `server/routes/proposals/metadata.js`: `GET /packages` `:16-21` and `GET /addons` `:24-29` (active rows, `requireAdminOrManager`); `POST /calculate` `:34-131` returns the full pricing snapshot (`.total`, `.gratuity.total`), defaults `guest_count || 50`, prices the contract's hours when `proposal_id` is sent, and runs no curfew, rules or pending-extension check.
- `server/routes/proposals/notifyPreflight.js` (sensitive-listed, NOT touched): `POST /:id/notify-preflight` takes the PATCH body and returns `{ notices }`; a notice exists exactly when `reschedulableStatusOk(status) && hasReschedulableChange(old, updated)` (`server/utils/clientNotices.js:27-29`, `server/utils/rescheduleProposal.js:95-97`: booked and not archived, and date, start or location changed). The staff reschedule hooks fire on the same condition (`crud.js:905-918`), so the staff choice belongs in the step that the notice opens. Notice shape: `{ type, reasons, composable, recipient: { name, email, phone }, channels: { email: { available, default, unavailable_reason }, sms: {...} }, autopay_notice, draft: { email: { subject, body_text }, sms: { body } } }`.
- `server/routes/proposals/actions.js:38-51` `PATCH /:id/notes`: `{ admin_notes }`, 10,000-character cap, writes `admin_notes || ''`, returns `{ id, admin_notes }`.
- `server/routes/proposals/getOne.js` `GET /proposals/:id` returns `p.*` (so `updated_at`, `admin_notes`, `gratuity_rate_change_origin`, `num_bartenders`, the venue parts, `setup_minutes_before`) plus `client_name`, `setup_time_display`, `settled_extension_hours` (always a number), `contract_floor_hours`, `off_contract_paid_cents`, `addons` (quantity coerced to a number). `server/db/schema.sql:890-891`: `update_proposals_updated_at` sets `updated_at` on every UPDATE of a proposal, so a changed `updated_at` means the row was written.
- `client/src/pages/admin/proposalEditor/ProposalEditorForm.js` (883 lines): override detection `:67-82`; stored gratuity `:99-104`; mandate lock `:106-112`; catalog load and `recoverAddonQuantities` `:115-145`; preview body `:179-208` inside the debounced effect `:167-241`; `buildBody` with `isClassPackage` `:356-369`; `doSave` client PUT `:379-386`, PATCH `:387`, outcome toasts `:388-399`, curfew retry `:409-426`; `proceedToNotify` `:442-461`; `handleSave` with `buildRepriceSummary` `:483-516`; the NotifyConfirmModal mount with `primary="quiet"` `:871-880`. Duration stepper `min={1} max={12} step={0.5}` `:603`; start picker `minHour={6} maxHour={23}` `:597-599` (`TimePicker.js:63-66`: the last slot is 23:30); the extension hint copy `:607-615`.
- `client/src/components/comms/NotifyConfirmModal.jsx` (229 lines): constants and reason labels `:19-28`; draft seeding `:41-49`; over-cap `:97-102`; `buildNotify` `:105-114`; the edit popup is called with `primary="quiet"`, which puts "Don't send" rightmost and success-styled (`:14-18`, `:222`). Other callers (payment and refund popups) use the same component; its behaviour must not move.
- `client/src/pages/admin/proposalEditor/formState.js`: `initialFormFromProposal(p)` (guest count falls back to 50, duration to 4, `setup_minutes_before ?? ''`), `pricedDurationHours(p)`, `recoverAddonQuantities(addons, catalog, { durationHours })`. `patchBody.js` `buildProposalPatchBody(form, { isClassPackage, changeRequestId, staffNotify, numBartendersOverride, includeGratuityMandate })` always sends the five venue keys today. `repriceSummary.js` `buildRepriceSummary({ status, totalPrice, amountPaid, newTotal, offContractPaidCents })`, `BOOKED_STATUSES = ['deposit_paid', 'balance_paid', 'confirmed', 'completed']`.
- `client/src/utils/proposalRules.js:150-155` `isQuantityCapable`: `banquet-server`, `barback`, `pre-batched-mocktail`, `additional-bartender`.
- `client/src/components/adminos/format.js:68-80` `fmtTime24`: '' for empty, "7:00 PM" → "19:00", unparseable returned as is. `ctDay(new Date())` is today's Chicago date as `YYYY-MM-DD`. `fmt$2dp(n)` formats dollars. `client/src/utils/eventCards.js:17-25` `railParts(ymd)` → `{ dow: 'SAT', day: '08', mon: 'AUG' }`. `client/src/utils/eventDetailView.js`: `setupOf(p)` → "from 17:15 · 45 min before" (or "from 17:15" with no gap, or null) `:143-152`; `headerOf(p)` `:99`; the private `dollars(n)` `:57-61` (signed, true minus, cents).
- `client/src/pages/mobile/EventDetailPhone.js` (379 lines, sensitive-listed): `SHEETS = ['shift']` `:51`; `drawer = useDrawerParam({ push: true, kinds: SHEETS })` `:64`; `readShifts(fresh)` `:106-135`; the load effect `:137-178`; `staleAt` `:198`; the param-drop effect `:212-215`; the Edit details row `:346-364` (`setDesktopView('event-detail', true)`, "desktop view" or "needs connection"); the AssignmentSheet mount `:366-376`. `client/src/pages/mobile/EventDetailSections.js` (163 lines) holds the presentational sections and imports `Icon`.
- `client/src/hooks/useDrawerParam.js`: `{ kind, id, focus, open(kind, id, { focus }), close() }`; with `{ push: true, kinds }` an open of a listed kind pushes one entry and close pops it; a deep-linked sheet gets an entry seeded behind it; ids must be digits.
- `client/src/hooks/useSheetFocus.js`: `useSheetFocus(sheetRef, handlersRef)` moves focus in, traps Tab, Escape calls `handlersRef.current.onClose`, and returns focus to the opener on unmount.
- `client/src/index.css`: the sheet family exists (`.m-sheet-scrim`, `.m-sheet`, `.m-sheet-handle`, `.m-sheet-head`, `.m-sheet-title`, `.m-sheet-kind`, `.m-sheet-mix`, `.m-sheet-body`, `.m-sheet-busy`, `.m-sheet-row`, `.m-sheet-note`, `.m-sheet-note-dot`, `.m-sheet-note-text`, `.m-sheet-state`, `.m-acts`, `.m-act` with `m-act-primary` / `m-act-quiet`, `.m-confirm`, `.m-confirm-copy`, `.m-confirm-btns`, `.m-fail`, `.m-fail-msg`, `.m-fail-retry`, `.m-saving`) around `:21523-21670`; `.m-section-row` `:21466`, `.m-section-name { flex: 1; }` `:21473`, `.m-edit-note`, `.m-edit-note-locked`. NO `.m-stepper*` rule exists.
- `client/src/components/adminos/Icon.js` names used here exist: `calendar`, `clock`, `pen`, `clipboard`, `right`.
- `client/src/utils/mobileClassContract.test.js`: every `m-*` class in the listed SOURCES must be defined in `index.css`; only phone screens import `offlineRead`.
- `client/src/context/ToastContext.js`: `useToast()` gives `success`, `error`, `info`; the provider wraps the whole app, so toasts show on the phone too.
- Prod, read-only, 2026-10-05: 478 proposals; 7 use a half-hour duration (3.5, 5.5, 6.5) and durations run 1 to 8 hours; 7 have a guest count that is not a multiple of five, none of the 18 upcoming booked events does. 2026-09-30: every roster is a list of known roles, none mixed. 0 upcoming multi-shift events (2026-09-28).
- `scripts/sensitive-paths.txt` lists `client/src/pages/mobile/EventDetailPhone.js`, `server/routes/proposals/crud.js`, `server/routes/proposals/notifyPreflight.js`; it does not list anything under `client/src/pages/admin/proposalEditor/` or `client/src/components/comms/`.

**Decisions this plan makes (each is in the spec, section 3, "Brainstorm decisions of 2026-10-05", except the ones marked "plan", which Task 8 adds there). They are the complete list of intended departures from the benchmark: `ui-ux-review` treats them as the contract, and any other difference is a finding.**
1. The sheet opens on an upcoming, live event only; a past event keeps "desktop view"; a stored copy reads "needs connection"; unlocked, the row reads "date · time · guests" (spec).
2. Duration steps in half hours, 1 to 12, reading "4.5 hr"; Guests step in fives landing on multiples of five, 1 to 1000; the row label is "Duration", as drawn (spec).
3. Setup is read-only and carries no arrow (the benchmark draws an arrow) (spec).
4. Date and Start use the phone's own pickers, the picker opening on a tap anywhere on the row; Start is clamped to 06:00 to 23:30; the date picker starts at today, Chicago's (spec).
5. Picking the start time the event already has keeps the stored value as stored ("7:00 PM" stays "7:00 PM"), so an unchanged time never reads as a reschedule (plan).
6. The new total shows only after a field changed. An untouched sheet says "Done" and closes without a request, even when today's catalog would price the event differently (plan).
7. Confirm is disabled while the figure is on its way or failed; a failed figure says "Couldn't price the change." with Retry (spec; copy plan).
8. The confirm lines are "New total $old → $new", on a booked event "balance due becomes $X", then the desktop's own reprice lines, including the new gratuity line both surfaces gain (spec).
9. "This event changed since you opened it." with Reload, when the row's `updated_at` moved; Reload re-reads and discards the sheet's edits (spec).
10. The notify step mirrors the desktop popup, in the same sheet, with "Don't send" the main, rightmost button and a staff block off by default; the wording is not editable on the phone (spec).
11. Past the curfew: an inline confirm with the server's reason, "Book it anyway? This will be recorded.", "Keep editing" and "Book it anyway"; "Keep editing" leaves "Not saved. The end time is past our 2:00 AM service curfew." (spec; the declined line is the desktop's copy).
12. While a save is in flight a "Saving" line shows above the buttons, every control is disabled, and the scrim and Escape do nothing (plan, the ma-e2 law).
13. After a save: "Event updated." and the desktop's channel toasts; the sheet closes; the detail re-reads fresh, and says "Saved. The event below could not be refreshed and may be out of date." with Retry if it cannot (spec).
14. The extension hint and the multi-shift note sit under Duration and under Guests (spec; multi-shift copy plan).
15. The Note row sits between Financials and Edit details on every event, cancelled included; it shows the note's first line or "Add a note"; on a stored copy it reads "needs connection" (spec; placement plan).
16. The note sheet's head reads "Note" over "internal · never shown to staff or clients"; its textarea is 16px so iOS does not zoom; Save is disabled until the text differs from the stored note; Back and the scrim keep an unsaved draft, Cancel clears it; a note that changed while the sheet was open shows the newer note with "Discard mine" and "Save mine" (spec; head copy and the disabled Save plan).

## Global Constraints

- **No em dashes** in copy, comments, commit messages or docs. Commas, colons, parentheses, the middle dot. A missing value renders as nothing.
- **No server change.** The lane edits nothing under `server/` and does not touch the service worker.
- **Desktop behaviour is frozen** apart from the gratuity reprice line: the desktop editor's preview body, save payload, toasts, curfew retry and notify popup are byte-for-byte what they were. Task 1's tests and the existing editor suites pin it; Checkpoint A reviews it.
- **Fresh reads only in the sheets.** `useEditSheet.js` and `NoteSheet.js` import `api` and never `offlineRead`; no request they make carries `X-Offline-Ok`. The read after a save in `EventDetailPhone` is plain `api.get` too.
- **The save payload is the desktop's:** `buildProposalPatchBody(form, { isClassPackage, numBartendersOverride, includeGratuityMandate: false, includeVenue: false })` on the form `initialFormFromProposal` + `recoverAddonQuantities` built, with only the four sheet fields replaced. Never a hand-built partial body.
- **One write at a time,** guarded by a ref, so a double tap sends one request. **Every PATCH re-reads the proposal first** and refuses when its `updated_at` moved since the sheet opened. **Writes never queue.**
- **Unique `m-*` class names for everything this lane adds,** modifiers included (`m-edit-native`, never `m-edit native`). Existing classes are reused as they are.
- **44px minimum tap targets** for every button, row and checkbox label this lane adds.
- **Copy from the benchmark, verbatim:** "Edit details", "date · time · guests", "needs connection", "event edit · reprices the booking", "Date", "Start", "Duration", "Setup", "Guests", "New total", "balance due becomes <$>", "Confirm new total", "Done", "Cancel".
- **Copy from the desktop, verbatim:** the extension hint "Includes <N>h of on-site extension, billed on its own invoice. The contract prices <N>h."; "Event updated."; "Saved, but the email failed: <reason>", "Saved, but the text failed: <reason>", "Saved. Email not sent: <reason>", "Saved. Text not sent: <reason>"; "Not saved. The end time is past our 2:00 AM service curfew."; "Book it anyway? This will be recorded."; the notify step's "Notify the client?", "Date changed", "Start time changed", "Location changed", "Current contact on file: <name> (<contact>).", "Email", "Text", "<Email|Text> unavailable: <reason>", "This message is not editable.", "Notify assigned staff", "Text (SMS)", "Staff are notified only when the date, time, or location actually changes.", "Send the update", "Don't send"; every reprice line `buildRepriceSummary` writes.
- **Added copy, held here so a reviewer can check it:** "Loading the event", "Couldn't load this event. Editing needs a connection.", "This event can no longer be edited here. Use desktop view.", "Couldn't price the change.", "This event changed since you opened it.", "Reload", "Retry", "Keep editing", "Book it anyway", "No connection, didn't save.", "Saving", "Something went wrong. Try again.", "Saved. The event below could not be refreshed and may be out of date.", "This event has <N> shifts. Changing the date or time here does not move them; each shift is edited from desktop view.", the gratuity line "The gratuity rises to <$>, so the client is emailed the new amount automatically, unless email to them is turned off.", the screen-reader names "Edit details", "Note", "Close", "Shorter", "Longer", "Fewer guests", "More guests", "Text the assigned staff", "Email the assigned staff" (the staff boxes' visible labels stay the desktop's "Text (SMS)" and "Email"; a distinct name keeps them apart from the client's "Email"); and for the note: "Note", "Add a note", "internal · never shown to staff or clients", "Loading the note", "Couldn't load the note. Editing needs a connection.", "This note changed since you opened it.", "The note is now empty.", "Discard mine", "Save mine", "Save".
- **Client tests:** `import '@testing-library/jest-dom'` in every test file; a `jest.mock` factory closes over `mock`-prefixed names only; CRA runs `resetMocks: true`, so mock return values are set in each test or a `beforeEach`; a ToastContext stub is one stable object.
- **Client gate:** `cd client && CI=true npx react-scripts build` before any commit touching `client/` (a lint warning is fatal there, and local lint misses `no-undef`).
- **File sizes:** new files stay under 400 lines; `EventDetailPhone.js` stays under 450 (the two new rows live in `EventDetailSections.js`); `ProposalEditorForm.js` shrinks.
- **Explicit staging only;** commit messages carry NO backticks; never `npm install` inside the lane (it replaces the shared `node_modules` symlink).
- **Docs law:** README folder tree (six new source files), ARCHITECTURE (the phone event detail passage), walkthroughs-owed (the Pixel walk), the fix list.

## Review Focus

The five conditions the spec implies that are most likely to bite Dallas on the phone, most likely first. Each has a named test in the task that owns the code.

1. **A double tap on Confirm, "Book it anyway" or "Send the update" on a slow connection.** Expected: one PATCH, one client notice. Pinned in Task 3 (`a second tap while a save is in flight sends nothing`) and Task 4 (`a second tap on Send the update sends one PATCH`).
2. **The preview never lands or fails** (a slow or dropped connection at a venue). Expected: Confirm stays disabled, "Couldn't price the change." with Retry, and no save of an unpriced change. Pinned in Task 3 (`a failed figure keeps Confirm disabled and Retry asks again`).
3. **The event moved while the sheet was open** (an on-site extension settled, the client paid, another admin saved). Expected: no PATCH, "This event changed since you opened it.", Reload brings the new values. Pinned in Task 3 (`an event that moved since the sheet opened is not saved`).
4. **An event with add-ons and a charged bartender override.** Expected: the PATCH carries the add-on ids, the recovered quantities and the override, and no venue key; nothing is dropped. Pinned in Task 3 (`the save sends the desktop's complete payload, without the venue keys`).
5. **A start time stored as "7:00 PM"** (what server-side creation writes). Expected: it shows as 19:00, an untouched or re-picked 19:00 is sent exactly as stored, and only a real change sends "HH:MM". Pinned in Task 2 (`nextStartValue keeps the stored value for the same time`) and Task 3 (`an untouched start time is sent as stored`).

Also pinned, lower on the list: a client with no email and no phone on a date change (Task 4: both channels unavailable, Send disabled, Don't send saves); the curfew refusal and its acknowledged retry (Task 3); a hosted 25-guest refusal shows the server's text (Task 3); Back keeps a note draft and Cancel clears it (Task 5); a note that changed meanwhile (Task 5); an edit param for another event, a past event or a stored copy is dropped (Task 6); the detail re-read after a save never takes a stored copy (Task 6).

## Lane map

```yaml
lanes:
  - id: ma-e3-edit-sheet
    phase: 3
    scope: >
      Phone edit sheet for the EVENT detail (date, start, duration, guests),
      saving through the desktop editor's own path: fresh reads, the desktop
      form state and complete payload without the venue keys, the shared
      /calculate preview, the desktop's reprice lines plus a new shared
      gratuity-email line, the desktop's notify step (Don't send primary,
      staff off), the curfew acknowledgement, a re-read before every PATCH
      that refuses when updated_at moved. A Note row and sheet for the
      internal booking note. Shared modules extracted from the desktop editor
      and the notify popup with desktop behaviour unchanged. Visual fidelity
      to the benchmark's Edit details row and edit sheet is owned here: the
      design system's stepper CSS is folded in and the benchmark's inline
      treatment becomes m-* classes.
    inputs:
      - docs/design-artifacts/2026-09-15-mobile-admin-shell.dc.html
      - docs/design-artifacts/_ds/dr-bartender-os-design-system-72035042-c993-47e2-9dc8-c452b7bf5fa4/components-mobile.css
    footprint:
      - client/src/pages/admin/proposalEditor/editorCore.js
      - client/src/pages/admin/proposalEditor/editorCore.test.js
      - client/src/pages/admin/proposalEditor/ProposalEditorForm.js
      - client/src/pages/admin/proposalEditor/patchBody.js
      - client/src/pages/admin/proposalEditor/patchBody.test.js
      - client/src/pages/admin/proposalEditor/repriceSummary.js
      - client/src/pages/admin/proposalEditor/repriceSummary.test.js
      - client/src/components/comms/notifyDrafts.js
      - client/src/components/comms/notifyDrafts.test.js
      - client/src/components/comms/NotifyConfirmModal.jsx
      - client/src/utils/editSheetView.js
      - client/src/utils/editSheetView.test.js
      - client/src/utils/eventDetailView.js
      - client/src/components/mobile/useEditSheet.js
      - client/src/components/mobile/EditSheet.js
      - client/src/components/mobile/EditSheet.test.js
      - client/src/components/mobile/NoteSheet.js
      - client/src/components/mobile/NoteSheet.test.js
      - client/src/pages/mobile/EventDetailPhone.js
      - client/src/pages/mobile/EventDetailPhone.test.js
      - client/src/pages/mobile/EventDetailSections.js
      - client/src/utils/mobileClassContract.test.js
      - client/src/index.css
      - scripts/sensitive-paths.txt
      - README.md
      - ARCHITECTURE.md
      - docs/walkthroughs-owed.md
      - docs/fix-list-remaining-2026-07-02.md
    depends_on: []  # ma-e2-event-detail is merged (91dcfab8) and live
    review_fleet: [code-review, consistency-check, security-review, performance-review, ui-ux-review, second-opinion]
    # A sensitive path (EventDetailPhone.js) is in the footprint and the lane adds a
    # money write surface, so this is the full fleet that applies. security-review:
    # the money sheet must never open from a stored copy, the notice send, the
    # payload. consistency-check: phone and desktop must say the same thing from one
    # copy of each rule. performance-review: the preview re-asks /calculate as the
    # values step. ui-ux-review judges the Edit details row and the edit sheet
    # against the benchmark, with the Decisions above as the contract. No
    # database-review: no SQL changes. second-opinion at push (money write surface).

  # Declared in the 2026-09-15 plan, unchanged, each with its own plan when its turn
  # comes: ma-f1-proposals-list, ma-f2-proposal-detail (reuses this lane's sheet for
  # the proposal variant), ma-f3-search.
```

**Task order.** Tasks run in the order written: 1, Checkpoint A, 2, 3, 4, 5, 6, 7, 8, 9. Task 1 is the shared modules and the desktop rewire; Checkpoint A (the orchestrator runs `code-review` and `consistency-check` on Task 1's diff, brief below) must pass before any phone code. Task 2 is pure and independent of Task 1's React changes but imports two of its modules. Task 3 builds the hook and the edit view; Task 4 adds the notify step to both; Task 5 is the note sheet; Task 6 wires both sheets into the detail; Task 7 is the browser gate; Task 8 the docs; Task 9 the lane close.

**Checkpoint A brief (after Task 1).** `code-review` and `consistency-check`, each on `git diff <lane base>..HEAD` after Task 1. Ask: is every desktop call site byte-equivalent to before (the preview body for every combination of override, mandate dirty and locked, proposal id; the save payload with `includeVenue` defaulted; the toasts in the same order; NotifyConfirmModal's drafts, over-cap and payload for the edit, payment and refund popups); is the gratuity line's condition the server's own (`crud.js:531-551`, `gratuityMandate.js:58-65`), and is it absent wherever the server would not send the email; does any import cycle appear. Findings fold into Task 1 before Task 2 starts.

**Who writes what.** An implementer sees this header and their own task, commits only the paths their task names, and reports anything the plan should record. The plan and the spec live on main and are edited there by the orchestrator, never from the lane.

---

### Task 1: Shared editor and notify modules, desktop rewired, the gratuity line

**Files:**
- Create: `client/src/pages/admin/proposalEditor/editorCore.js`
- Create: `client/src/pages/admin/proposalEditor/editorCore.test.js`
- Create: `client/src/components/comms/notifyDrafts.js`
- Create: `client/src/components/comms/notifyDrafts.test.js`
- Modify: `client/src/pages/admin/proposalEditor/patchBody.js`, `patchBody.test.js`
- Modify: `client/src/pages/admin/proposalEditor/repriceSummary.js`, `repriceSummary.test.js`
- Modify: `client/src/pages/admin/proposalEditor/ProposalEditorForm.js`
- Modify: `client/src/components/comms/NotifyConfirmModal.jsx`

**Interfaces:**
- Produces (editorCore.js): `detectNumBartendersOverride(proposal, packages) → number|null`; `storedGratuityOf(proposal) → { rate: number, tipJar: boolean }`; `mandateLockedFor(proposal) → boolean`; `isClassPackageFor(selectedPkg, proposal) → boolean`; `buildCalculateBody(form, { proposalId, numBartendersOverride, tipJar, gratuityRate, includeMandate }) → object`.
- Produces (notifyDrafts.js): `SUBJECT_MAX = 300`, `SMS_MAX_CHARS = 640`, `REASON_LABELS`, `humanizeReason(reason) → string`, `initialDrafts(notices) → Draft[]` where `Draft = { type, channels: string[], subject, bodyText, smsBody }`, `draftsOverCap(notices, drafts) → boolean`, `buildNotifyEntries(notices, drafts) → object[]`, `noticeOutcomes(notifications) → { kind: 'error'|'info', text }[]`.
- Produces (patchBody.js): `buildProposalPatchBody(form, { ..., includeVenue = true })`; `staffNotifyFlags({ enabled, sms, email }) → { notify_assigned_staff, notify_staff_sms, notify_staff_email }`.
- Produces (repriceSummary.js): `buildRepriceSummary({ status, totalPrice, amountPaid, newTotal, offContractPaidCents = 0, gratuityOrigin = null, oldGratuityTotal = null, newGratuityTotal = null })`.

- [ ] **Step 1: Write the failing tests for editorCore**

Create `client/src/pages/admin/proposalEditor/editorCore.test.js`:

```js
import '@testing-library/jest-dom';
import {
  detectNumBartendersOverride, storedGratuityOf, mandateLockedFor, isClassPackageFor, buildCalculateBody,
} from './editorCore';

const pkg = { id: 1, guests_per_bartender: 100, bar_type: 'service_only' };

describe('detectNumBartendersOverride', () => {
  test('no stored count is no override', () => {
    expect(detectNumBartendersOverride({ num_bartenders: null, package_id: 1, guest_count: 100 }, [pkg])).toBeNull();
  });
  test('a retired package cannot be judged, so nothing travels', () => {
    expect(detectNumBartendersOverride({ num_bartenders: 3, package_id: 9, guest_count: 100 }, [pkg])).toBeNull();
  });
  test('the ratio count is not an override', () => {
    expect(detectNumBartendersOverride({ num_bartenders: 2, package_id: 1, guest_count: 150 }, [pkg])).toBeNull();
  });
  test('a count off the ratio is the override, and travels', () => {
    expect(detectNumBartendersOverride({ num_bartenders: 3, package_id: '1', guest_count: 150 }, [pkg])).toBe(3);
  });
  test('a package with no ratio counts 100 guests per bartender', () => {
    expect(detectNumBartendersOverride({ num_bartenders: 1, package_id: 1, guest_count: 80 }, [{ id: 1 }])).toBeNull();
    expect(detectNumBartendersOverride({ num_bartenders: 2, package_id: 1, guest_count: 80 }, [{ id: 1 }])).toBe(2);
  });
});

test('storedGratuityOf reads the stored rate and jar, defaulting to no rate and the jar on', () => {
  expect(storedGratuityOf({ pricing_snapshot: { gratuity: { rate: '12.5', tip_jar: false } } })).toEqual({ rate: 12.5, tipJar: false });
  expect(storedGratuityOf({})).toEqual({ rate: 0, tipJar: true });
});

test('mandateLockedFor: paid, signed or accepted locks the mandate', () => {
  expect(mandateLockedFor({ amount_paid: '100' })).toBe(true);
  expect(mandateLockedFor({ amount_paid: '0', client_signed_at: '2026-01-01' })).toBe(true);
  expect(mandateLockedFor({ amount_paid: '0', status: 'accepted' })).toBe(true);
  expect(mandateLockedFor({ amount_paid: '0', client_signed_at: null, status: 'sent' })).toBe(false);
});

test('isClassPackageFor: the selected package decides, a retired one keeps the stored class options', () => {
  expect(isClassPackageFor({ bar_type: 'class' }, {})).toBe(true);
  expect(isClassPackageFor({ bar_type: 'service_only' }, { class_options: {} })).toBe(false);
  expect(isClassPackageFor(undefined, { class_options: { spirit_category: 'gin' } })).toBe(true);
  expect(isClassPackageFor(undefined, { class_options: null })).toBe(false);
});

describe('buildCalculateBody', () => {
  const form = {
    package_id: '3', guest_count: '75', event_duration_hours: '5', num_bars: '1',
    addon_ids: [7, '9'], addon_variants: { 7: 'x' }, addon_quantities: { 9: 3 },
    syrup_selections: [{ id: 1 }], adjustments: [{ type: 'discount', amount: 50 }],
    total_price_override: null, gratuity_mandate_total: 300,
  };
  test('the desktop body, field for field', () => {
    expect(buildCalculateBody(form, { proposalId: 42, tipJar: false, gratuityRate: 10 })).toEqual({
      proposal_id: 42, package_id: 3, guest_count: 75, duration_hours: 5, num_bars: 1,
      addon_ids: [7, 9], addon_variants: { 7: 'x' }, addon_quantities: { 9: 3 },
      syrup_selections: [{ id: 1 }], adjustments: [{ type: 'discount', amount: 50 }],
      total_price_override: null, tip_jar: false, gratuity_rate: 10,
    });
  });
  test('no proposal id, blank guests and duration fall back as the desktop preview does', () => {
    const body = buildCalculateBody({ ...form, guest_count: '', event_duration_hours: 0 }, {});
    expect(body).not.toHaveProperty('proposal_id');
    expect(body.guest_count).toBe(50);
    expect(body.duration_hours).toBe(4);
  });
  test('the override travels only when detected', () => {
    expect(buildCalculateBody(form, { numBartendersOverride: 3 }).num_bartenders).toBe(3);
    expect(buildCalculateBody(form, { numBartendersOverride: null })).not.toHaveProperty('num_bartenders');
  });
  test('the mandate rides only when included, and never as a transient 0 or blank', () => {
    expect(buildCalculateBody(form, { includeMandate: true }).gratuity_mandate_total).toBe(300);
    expect(buildCalculateBody({ ...form, gratuity_mandate_total: null }, { includeMandate: true }).gratuity_mandate_total).toBeNull();
    expect(buildCalculateBody({ ...form, gratuity_mandate_total: 0 }, { includeMandate: true })).not.toHaveProperty('gratuity_mandate_total');
    expect(buildCalculateBody({ ...form, gratuity_mandate_total: '' }, { includeMandate: true })).not.toHaveProperty('gratuity_mandate_total');
    expect(buildCalculateBody(form, { includeMandate: false })).not.toHaveProperty('gratuity_mandate_total');
  });
});
```

- [ ] **Step 2: Write the failing tests for notifyDrafts**

Create `client/src/components/comms/notifyDrafts.test.js`:

```js
import '@testing-library/jest-dom';
import {
  SUBJECT_MAX, humanizeReason, initialDrafts, draftsOverCap, buildNotifyEntries, noticeOutcomes,
} from './notifyDrafts';

const notice = (over = {}) => ({
  type: 'event_details', composable: true,
  channels: { email: { available: true, default: true }, sms: { available: true, default: false } },
  draft: { email: { subject: 'Your event moved', body_text: 'Hi' }, sms: { body: 'Moved' } },
  ...over,
});

test('humanizeReason names the columns in admin words and passes anything else through', () => {
  expect(humanizeReason('event_date changed')).toBe('Date changed');
  expect(humanizeReason('event_start_time changed')).toBe('Start time changed');
  expect(humanizeReason('event_location changed')).toBe('Location changed');
  expect(humanizeReason('something else')).toBe('something else');
});

test('initialDrafts ticks the channels that are available AND defaulted, and seeds the text', () => {
  expect(initialDrafts([notice()])).toEqual([{
    type: 'event_details', channels: ['email'], subject: 'Your event moved', bodyText: 'Hi', smsBody: 'Moved',
  }]);
  expect(initialDrafts([notice({ channels: { email: { available: false, default: true } }, draft: {} })]))
    .toEqual([{ type: 'event_details', channels: [], subject: '', bodyText: '', smsBody: '' }]);
});

test('draftsOverCap: a ticked channel with empty or over-long text is refused; untick it and it is not', () => {
  const n = [notice()];
  const d = initialDrafts(n);
  expect(draftsOverCap(n, d)).toBe(false);
  expect(draftsOverCap(n, [{ ...d[0], subject: '' }])).toBe(true);
  expect(draftsOverCap(n, [{ ...d[0], subject: 'x'.repeat(SUBJECT_MAX + 1) }])).toBe(true);
  expect(draftsOverCap(n, [{ ...d[0], channels: ['sms'], smsBody: '' }])).toBe(true);
  expect(draftsOverCap(n, [{ ...d[0], channels: [], subject: '' }])).toBe(false);
  expect(draftsOverCap([notice({ composable: false })], [{ ...d[0], subject: '' }])).toBe(false);
});

test('buildNotifyEntries: one entry per notice with a ticked channel, text only for a composable one', () => {
  const n = [notice()];
  expect(buildNotifyEntries(n, [{ ...initialDrafts(n)[0], channels: ['email', 'sms'] }])).toEqual([{
    type: 'event_details', channels: ['email', 'sms'],
    email: { subject: 'Your event moved', body_text: 'Hi' }, sms: { body: 'Moved' },
  }]);
  expect(buildNotifyEntries(n, [{ ...initialDrafts(n)[0], channels: [] }])).toEqual([]);
  const fixed = [notice({ composable: false })];
  expect(buildNotifyEntries(fixed, initialDrafts(fixed))).toEqual([{ type: 'event_details', channels: ['email'] }]);
});

test('noticeOutcomes: failures, then real skips; "not selected" stays silent', () => {
  expect(noticeOutcomes([
    { email: 'failed', email_error: 'bounced', sms: 'skipped', skip_reasons: { sms: 'opted out' } },
    { email: 'skipped', sms: 'failed', skip_reasons: { email: 'not selected' } },
  ])).toEqual([
    { kind: 'error', text: 'Saved, but the email failed: bounced' },
    { kind: 'info', text: 'Saved. Text not sent: opted out' },
    { kind: 'error', text: 'Saved, but the text failed: unknown error' },
  ]);
  expect(noticeOutcomes(undefined)).toEqual([]);
});
```

- [ ] **Step 3: Add the failing tests for the patch body and the reprice line**

Append to `client/src/pages/admin/proposalEditor/patchBody.test.js` (it already defines `form`; add `staffNotifyFlags` to its import line, so it reads `import { buildProposalPatchBody, staffNotifyFlags } from './patchBody';`):

```js
describe('includeVenue (lane ma-e3)', () => {
  const VENUE = ['venue_name', 'venue_street', 'venue_city', 'venue_state', 'venue_zip'];
  it('sends the five venue keys by default, as before', () => {
    const body = buildProposalPatchBody(form, {});
    VENUE.forEach((k) => expect(body).toHaveProperty(k));
  });
  it('includeVenue: false leaves out exactly the five venue keys', () => {
    const full = buildProposalPatchBody(form, {});
    const lean = buildProposalPatchBody(form, { includeVenue: false });
    VENUE.forEach((k) => expect(lean).not.toHaveProperty(k));
    const rest = { ...full };
    VENUE.forEach((k) => { delete rest[k]; });
    expect(lean).toEqual(rest);
  });
});

describe('staffNotifyFlags', () => {
  it('sends the sub-flags only under the parent toggle', () => {
    expect(staffNotifyFlags({ enabled: false, sms: true, email: true }))
      .toEqual({ notify_assigned_staff: false, notify_staff_sms: false, notify_staff_email: false });
    expect(staffNotifyFlags({ enabled: true, sms: true, email: false }))
      .toEqual({ notify_assigned_staff: true, notify_staff_sms: true, notify_staff_email: false });
  });
  it('is what the payload carries for a staff choice', () => {
    expect(buildProposalPatchBody(form, { staffNotify: { enabled: true, sms: false, email: true } }))
      .toMatchObject({ notify_assigned_staff: true, notify_staff_sms: false, notify_staff_email: true });
  });
});
```

Append to `client/src/pages/admin/proposalEditor/repriceSummary.test.js`:

```js
// The gratuity staffing-change email is automatic (crud.js post-commit,
// gratuityMandate.js staffingGratuityOrigin): neither confirm said so until lane ma-e3.
describe('the automatic gratuity email line', () => {
  const LINE = 'The gratuity rises to $160.00, so the client is emailed the new amount automatically, unless email to them is turned off.';
  const base = { status: 'deposit_paid', totalPrice: '1000', amountPaid: '100', newTotal: 1040, oldGratuityTotal: 120, newGratuityTotal: 160 };
  it('shows when money is paid, the gratuity was not set by hand, and it rises', () => {
    expect(buildRepriceSummary(base).lines).toContain(LINE);
    expect(buildRepriceSummary({ ...base, gratuityOrigin: 'staffing' }).lines).toContain(LINE);
  });
  it('sits just before the invoice line, which stays last', () => {
    const { lines } = buildRepriceSummary(base);
    expect(lines[lines.length - 2]).toBe(LINE);
    expect(lines[lines.length - 1]).toBe('Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.');
  });
  it('does not show when nothing is paid, when the gratuity was set by hand, or when it does not rise', () => {
    expect(buildRepriceSummary({ ...base, amountPaid: '0' }).lines).not.toContain(LINE);
    expect(buildRepriceSummary({ ...base, gratuityOrigin: 'admin' }).lines).not.toContain(LINE);
    expect(buildRepriceSummary({ ...base, newGratuityTotal: 120 }).lines.some((l) => l.startsWith('The gratuity rises'))).toBe(false);
    expect(buildRepriceSummary({ ...base, newGratuityTotal: 100 }).lines.some((l) => l.startsWith('The gratuity rises'))).toBe(false);
    expect(buildRepriceSummary({ ...base, newGratuityTotal: null }).lines.some((l) => l.startsWith('The gratuity rises'))).toBe(false);
  });
  it('old callers that pass no gratuity figures get no line', () => {
    const { lines } = buildRepriceSummary({ status: 'deposit_paid', totalPrice: '1000', amountPaid: '100', newTotal: 1040 });
    expect(lines.some((l) => l.startsWith('The gratuity rises'))).toBe(false);
  });
});
```

- [ ] **Step 4: Run the new tests to verify they fail**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/proposalEditor/editorCore.test.js src/components/comms/notifyDrafts.test.js src/pages/admin/proposalEditor/patchBody.test.js src/pages/admin/proposalEditor/repriceSummary.test.js`
Expected: FAIL (`Cannot find module './editorCore'`, `'./notifyDrafts'`, `staffNotifyFlags is not a function`, and the gratuity line missing).

- [ ] **Step 5: Create editorCore.js**

Create `client/src/pages/admin/proposalEditor/editorCore.js`:

```js
// The pieces of the proposal/event editor that the phone edit sheet (lane
// ma-e3, client/src/components/mobile/useEditSheet.js) shares with the desktop
// editor (ProposalEditorForm.js). Moved out of ProposalEditorForm verbatim:
// one copy, so the two surfaces cannot drift. The other shared builders live
// beside this file: formState.js (the form a proposal seeds), patchBody.js
// (the save payload), repriceSummary.js (the booked-event reprice lines).

// Explicit bartender-count override detection (push-review money finding):
// stored num_bartenders equals the computed actual, so it is an admin
// override only when it differs from what the ORIGINAL inputs required.
// It must round-trip through preview AND PATCH or any editor save silently
// drops charged over-ratio bartenders. A retired original package (absent
// from the active catalog) makes detection impossible: fall back to not
// sending (the server recomputes, matching pre-editor behavior).
export function detectNumBartendersOverride(proposal, packages) {
  const stored = Number(proposal?.num_bartenders);
  if (!stored) return null;
  const originalPkg = (packages || []).find((p) => p.id === Number(proposal.package_id));
  if (!originalPkg) return null;
  const per = Number(originalPkg.guests_per_bartender) || 100;
  const required = Math.max(1, Math.ceil((Number(proposal.guest_count) || 0) / per));
  return stored !== required ? stored : null;
}

// The gratuity is NOT editable in the editor (election-at-payment, spec
// 2026-08-03): the client elects it at sign-and-pay and the Stripe webhook
// persists it. These stored values only feed the preview request so a paid
// proposal's gratuity line keeps rendering (and rescaling) while staff/hours
// are edited.
export function storedGratuityOf(proposal) {
  return {
    rate: Number(proposal?.pricing_snapshot?.gratuity?.rate) || 0,
    tipJar: proposal?.pricing_snapshot?.gratuity?.tip_jar !== false,
  };
}

// Admin gratuity mandate (spec 2026-08-10). Locked once signed or paid: a
// recorded signature must never stand against a total admin changed after.
export function mandateLockedFor(proposal) {
  return Number(proposal?.amount_paid || 0) > 0
    || proposal?.client_signed_at != null || proposal?.status === 'accepted';
}

// Class-options gating for the save payload. A retired package (absent from
// the active catalog) keeps the stored class semantics instead of silently
// clearing class_options.
export function isClassPackageFor(selectedPkg, proposal) {
  return selectedPkg ? selectedPkg.bar_type === 'class' : proposal?.class_options != null;
}

// The POST /proposals/calculate body. Editing an existing booking sends its
// id: the server then prices the CONTRACT's hours (worked hours minus settled
// on-site extensions), so the preview equals what the PATCH will save. The
// gratuity is previewed at the STORED rate and jar (storedGratuityOf). A draft
// mandate rides only once touched and unlocked (includeMandate); transient
// typing states ('' / 0) are withheld so the preview never 400s mid-entry.
export function buildCalculateBody(form, {
  proposalId = null, numBartendersOverride = null, tipJar = true, gratuityRate = 0, includeMandate = false,
} = {}) {
  return {
    ...(proposalId ? { proposal_id: proposalId } : {}),
    package_id: Number(form.package_id),
    guest_count: Number(form.guest_count) || 50,
    duration_hours: Number(form.event_duration_hours) || 4,
    num_bars: Number(form.num_bars) || 0,
    ...(numBartendersOverride != null ? { num_bartenders: numBartendersOverride } : {}),
    addon_ids: (form.addon_ids || []).map(Number),
    addon_variants: form.addon_variants || {},
    addon_quantities: form.addon_quantities || {},
    syrup_selections: form.syrup_selections || [],
    adjustments: form.adjustments || [],
    total_price_override: form.total_price_override,
    tip_jar: tipJar,
    gratuity_rate: gratuityRate,
    ...(includeMandate
      && (form.gratuity_mandate_total == null || Number(form.gratuity_mandate_total) > 0)
      ? { gratuity_mandate_total: form.gratuity_mandate_total }
      : {}),
  };
}
```

- [ ] **Step 6: Create notifyDrafts.js**

Create `client/src/components/comms/notifyDrafts.js`:

```js
// The notify-client draft logic shared by the desktop popup
// (NotifyConfirmModal.jsx) and the phone edit sheet's notify step (lane
// ma-e3). Moved out of the popup verbatim: one copy, so the payload the server
// receives cannot depend on which surface built it.

export const SUBJECT_MAX = 300;
export const SMS_MAX_CHARS = 640;

// Server reasons arrive as `${column} changed`; show the admin words, not columns.
export const REASON_LABELS = {
  'event_date changed': 'Date changed',
  'event_start_time changed': 'Start time changed',
  'event_location changed': 'Location changed',
};
export const humanizeReason = (r) => REASON_LABELS[r] || r;

// One draft per notice: the channels the server marks available AND
// defaulted start ticked; the composable text starts as the server's draft.
export function initialDrafts(notices) {
  return (notices || []).map((n) => ({
    type: n.type,
    channels: Object.entries(n.channels || {})
      .filter(([, c]) => c && c.available && c.default)
      .map(([k]) => k),
    subject: n.draft?.email?.subject || '',
    bodyText: n.draft?.email?.body_text || '',
    smsBody: n.draft?.sms?.body || '',
  }));
}

// True when a ticked channel of a composable notice would be refused: an
// empty or over-long subject, an empty body, an empty or over-long text.
export function draftsOverCap(notices, drafts) {
  return (drafts || []).some((d, i) => {
    if (!notices[i] || !notices[i].composable) return false;
    if (d.channels.includes('email') && (d.subject.length > SUBJECT_MAX || !d.subject.trim() || !d.bodyText.trim())) return true;
    if (d.channels.includes('sms') && (d.smsBody.length > SMS_MAX_CHARS || !d.smsBody.trim())) return true;
    return false;
  });
}

// The PATCH `notify` list: one entry per notice with a ticked channel; a
// composable notice carries its text for each ticked channel.
export function buildNotifyEntries(notices, drafts) {
  return (drafts || [])
    .filter((d) => d.channels.length > 0)
    .map((d) => {
      const notice = notices.find((n) => n.type === d.type);
      const out = { type: d.type, channels: d.channels };
      if (!notice || !notice.composable) return out;
      if (d.channels.includes('email')) out.email = { subject: d.subject, body_text: d.bodyText };
      if (d.channels.includes('sms')) out.sms = { body: d.smsBody };
      return out;
    });
}

// Per-channel truth after a save (notify-client contract): failures and real
// skips surface; "not selected" and never-offered channels stay silent. Each
// entry is one toast, in the order the desktop always showed them.
export function noticeOutcomes(notifications) {
  const out = [];
  (notifications || []).forEach((n) => {
    if (n.email === 'failed') out.push({ kind: 'error', text: `Saved, but the email failed: ${n.email_error || 'unknown error'}` });
    if (n.sms === 'failed') out.push({ kind: 'error', text: `Saved, but the text failed: ${n.sms_error || 'unknown error'}` });
    ['email', 'sms'].forEach((ch) => {
      if (n[ch] === 'skipped' && n.skip_reasons?.[ch] && n.skip_reasons[ch] !== 'not selected') {
        out.push({ kind: 'info', text: `Saved. ${ch === 'email' ? 'Email' : 'Text'} not sent: ${n.skip_reasons[ch]}` });
      }
    });
  });
  return out;
}
```

- [ ] **Step 7: Extend patchBody.js**

In `client/src/pages/admin/proposalEditor/patchBody.js`, change the signature to add `includeVenue = true`, move the five venue keys out of the object literal into a guarded block, and replace the staff block with the new helper. The full new file:

```js
// The ONE place a proposal-editor save payload is built. Both mounts of
// ProposalEditorForm (proposal page and event page) and the phone edit sheet
// (lane ma-e3) call this, so the surfaces cannot drift. History: the old
// EventEditForm built its own payload and omitted addon_quantities; the server
// defaults an absent quantity to 1 (safeAddonQty), so a date edit from the
// event page silently reset admin-set add-on quantities. Structural fix: one
// builder, always complete.

// Sub-flags only ride when the parent toggle is on, so an unchecked parent
// never leaks a stale sub-flag (EventEditForm's Phase 4a rule, preserved).
export function staffNotifyFlags(staffNotify) {
  return {
    notify_assigned_staff: !!staffNotify.enabled,
    notify_staff_sms: !!(staffNotify.enabled && staffNotify.sms),
    notify_staff_email: !!(staffNotify.enabled && staffNotify.email),
  };
}

export function buildProposalPatchBody(form, {
  isClassPackage = false,
  changeRequestId,
  staffNotify = null,
  numBartendersOverride = null,
  includeGratuityMandate = false,
  includeVenue = true,
} = {}) {
  const body = {
    event_date: form.event_date,
    event_start_time: form.event_start_time,
    event_duration_hours: Number(form.event_duration_hours),
    guest_count: Number(form.guest_count),
    package_id: Number(form.package_id),
    num_bars: Number(form.num_bars) || 0,
    // Present ONLY for a detected admin override: absent means the server
    // recomputes staffing from the ratio (crud.js calculateStaffing). Sending
    // the stored actual unconditionally would PIN staffing across guest-count
    // changes; omitting a real override silently drops charged over-ratio
    // bartenders (push-review money finding).
    ...(numBartendersOverride != null ? { num_bartenders: Number(numBartendersOverride) } : {}),
    addon_ids: (form.addon_ids || []).map(Number),
    addon_variants: form.addon_variants || {},
    addon_quantities: form.addon_quantities || {},
    syrup_selections: form.syrup_selections || [],
    adjustments: form.adjustments || [],
    total_price_override: form.total_price_override,
    client_provides_glassware: !!form.client_provides_glassware,
    // Top Shelf is class-only. Only send class_options for a class package so
    // switching to a non-class package cannot trip the server-side guard.
    class_options: isClassPackage ? form.class_options : null,
    // Blank means reset to package default; the server treats null as the reset.
    setup_minutes_before: form.setup_minutes_before === '' || form.setup_minutes_before == null
      ? null
      : Number(form.setup_minutes_before),
  };
  // The five venue parts. The phone edit sheet never edits location and
  // leaves them out (includeVenue: false): absent, the server keeps every
  // column (COALESCE) and composes no new event_location, so a legacy row whose
  // stored location differs from its parts never reads as a location change.
  if (includeVenue) {
    body.venue_name = form.venue_name;
    body.venue_street = form.venue_street;
    body.venue_city = form.venue_city;
    body.venue_state = form.venue_state;
    body.venue_zip = form.venue_zip;
  }
  // No election keys, ever (election-at-payment, spec 2026-08-03): the tip-jar
  // election is client-owned at sign-and-pay and persisted by the Stripe
  // webhook. The admin PATCH ignores tip_jar/gratuity_total, so sending them
  // would only misrepresent what this form can do.
  // Admin gratuity mandate (spec 2026-08-10): the ONE gratuity key this form
  // may send, and ONLY when the admin touched the mandate this session and the
  // proposal is unsigned + unpaid (the caller gates both). An untouched form
  // omits the key so the server carries the stored mandate forward and a
  // staffing edit rescales the dollars at the canonical rate, never from the
  // stale displayed figure.
  if (includeGratuityMandate) {
    body.gratuity_mandate_total = form.gratuity_mandate_total == null
      ? null : Number(form.gratuity_mandate_total);
  }
  if (changeRequestId != null) body.change_request_id = changeRequestId;
  if (staffNotify) Object.assign(body, staffNotifyFlags(staffNotify));
  return body;
}
```

- [ ] **Step 8: Add the gratuity line to repriceSummary.js**

In `client/src/pages/admin/proposalEditor/repriceSummary.js`, change the signature line to:

```js
export function buildRepriceSummary({
  status, totalPrice, amountPaid, newTotal, offContractPaidCents = 0,
  gratuityOrigin = null, oldGratuityTotal = null, newGratuityTotal = null,
}) {
```

and insert this block immediately before the final `lines.push('Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.');`:

```js
  // The gratuity staffing-change email (crud.js post-commit; the condition is
  // gratuityMandate.js staffingGratuityOrigin with isPaid = amount_paid > 0):
  // sent automatically, outside the notify popup, when the booking has money
  // paid, the gratuity was not set by hand, and the gratuity total rises.
  // Neither confirm said so until lane ma-e3 (2026-10-05). The suppression
  // gate (preferences, bounces, a placeholder address) can still stop it,
  // hence the "unless".
  const oldG = Number(oldGratuityTotal) || 0;
  const newG = Number(newGratuityTotal);
  if (paid > 0 && gratuityOrigin !== 'admin' && newGratuityTotal != null
    && Number.isFinite(newG) && newG - oldG > 0.004) {
    lines.push(`The gratuity rises to ${usd(newG)}, so the client is emailed the new amount automatically, unless email to them is turned off.`);
  }
```

(`paid` and `usd` already exist in that function's scope.)

- [ ] **Step 9: Run the four suites to verify they pass**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/proposalEditor/editorCore.test.js src/components/comms/notifyDrafts.test.js src/pages/admin/proposalEditor/patchBody.test.js src/pages/admin/proposalEditor/repriceSummary.test.js`
Expected: PASS, every test.

- [ ] **Step 10: Rewire ProposalEditorForm.js onto the shared modules**

In `client/src/pages/admin/proposalEditor/ProposalEditorForm.js`:

1. Add after the `buildRepriceSummary` import:
```js
import {
  detectNumBartendersOverride, storedGratuityOf, mandateLockedFor, isClassPackageFor, buildCalculateBody,
} from './editorCore';
import { noticeOutcomes } from '../../../components/comms/notifyDrafts';
```
2. Replace the override block (the comment and `useMemo` at `:67-82`) with:
```js
  // Explicit bartender-count override (editorCore.js carries the why). It
  // must round-trip through preview AND PATCH.
  const numBartendersOverride = useMemo(
    () => detectNumBartendersOverride(proposal, packages),
    [packages, proposal]
  );
```
3. Replace the stored-gratuity lines (`:99-104`) with:
```js
  // Stored gratuity rate and jar, for the preview only (editorCore.js).
  const { rate: storedGratuityRate, tipJar: storedTipJar } = storedGratuityOf(proposal);
```
4. Replace the two `mandateLocked` lines (`:111-112`, keep the comment above them) with:
```js
  const mandateLocked = mandateLockedFor(proposal);
```
5. Replace the whole `api.post('/proposals/calculate', { ... })` argument object (`:179-208`) so the call reads:
```js
      api.post('/proposals/calculate', buildCalculateBody(editForm, {
        proposalId: proposal?.id,
        numBartendersOverride,
        tipJar: storedTipJar,
        gratuityRate: storedGratuityRate,
        includeMandate: mandateDirty && !mandateLocked,
      }))
```
(the `.then` and `.catch` that follow stay as they are; the effect's dependency list stays as it is).
6. In `buildBody`, replace the `isClassPackage:` line and its two comment lines with:
```js
    isClassPackage: isClassPackageFor(selectedPkg, proposal),
```
7. In `doSave`, replace the comment and the `(res.data.notifications || []).forEach(...)` block (`:389-399`) with:
```js
      // Per-channel truth (notify-client contract): notifyDrafts.js.
      noticeOutcomes(res.data.notifications).forEach((o) => toast[o.kind](o.text));
```
8. In `handleSave`, add three keys to the `buildRepriceSummary({ ... })` call, after `offContractPaidCents`:
```js
      gratuityOrigin: proposal.gratuity_rate_change_origin,
      oldGratuityTotal: proposal?.pricing_snapshot?.gratuity?.total,
      newGratuityTotal: (!previewStale && editPreview) ? editPreview?.gratuity?.total : null,
```

- [ ] **Step 11: Rewire NotifyConfirmModal.jsx onto notifyDrafts**

In `client/src/components/comms/NotifyConfirmModal.jsx`:
1. Delete the `SUBJECT_MAX`, `SMS_MAX_CHARS`, `REASON_LABELS` and `humanizeReason` declarations (`:19-28`) and add after the imports:
```js
import {
  SUBJECT_MAX, SMS_MAX_CHARS, humanizeReason, initialDrafts, draftsOverCap, buildNotifyEntries,
} from './notifyDrafts';
```
2. Replace the `useState(() => (notices || []).map(...))` initializer with `useState(() => initialDrafts(notices))`.
3. Replace the `overCap` computation with `const overCap = draftsOverCap(notices, drafts);`.
4. Replace the `buildNotify` body with `const buildNotify = () => buildNotifyEntries(notices, drafts);`.

- [ ] **Step 12: Run every editor and comms suite plus the CI build**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/proposalEditor src/components/comms src/pages/admin/ProposalDetail src/pages/admin/EventDetailPage`
Expected: PASS (the extension test still sees `proposal_id` 4242 and `duration_hours` 5; the smoke test resolves the graph).
Run: `cd client && CI=true npx react-scripts build`
Expected: "Compiled" (a missing-source-map warning from html2pdf.js is old and not this lane's), exit 0.

- [ ] **Step 13: Commit**

```bash
git add client/src/pages/admin/proposalEditor/editorCore.js client/src/pages/admin/proposalEditor/editorCore.test.js client/src/components/comms/notifyDrafts.js client/src/components/comms/notifyDrafts.test.js client/src/pages/admin/proposalEditor/patchBody.js client/src/pages/admin/proposalEditor/patchBody.test.js client/src/pages/admin/proposalEditor/repriceSummary.js client/src/pages/admin/proposalEditor/repriceSummary.test.js client/src/pages/admin/proposalEditor/ProposalEditorForm.js client/src/components/comms/NotifyConfirmModal.jsx
git commit -m "refactor(editor): shared editor and notify modules for the phone sheet; the reprice confirm names the automatic gratuity email"
```

### Checkpoint A (orchestrator, before Task 2)

Run `code-review` and `consistency-check` on the Task 1 diff with the brief in the header. Fold every finding into Task 1 (new commits) and re-run the suites in Step 12. Record the verdicts in the Self-Review.

### Task 2: The edit sheet's pure view-model

**Files:**
- Create: `client/src/utils/editSheetView.js`
- Create: `client/src/utils/editSheetView.test.js`
- Modify: `client/src/utils/eventDetailView.js` (export `dollars`)

**Interfaces:**
- Consumes: `buildRepriceSummary`, `BOOKED_STATUSES` (Task 1's `repriceSummary.js`); `dollars`, `setupOf` (`eventDetailView.js`); `railParts` (`eventCards.js`); `fmtTime24` (`components/adminos/format.js`).
- Produces: `HOURS_MIN=1`, `HOURS_MAX=12`, `GUESTS_MIN=1`, `GUESTS_MAX=1000`, `START_MIN='06:00'`, `START_MAX='23:30'`, `SHEET_NOTE`, `STALE_EVENT`, `PREVIEW_FAILED`, `NO_CONNECTION`, `LOCKED_NOTE`; `stepHours(v, dir)`, `stepGuests(v, dir)`, `canStep(v, dir, step) → boolean`, `fmtHours(v) → '4.5 hr'`, `clampStart(v) → 'HH:MM'|null`, `startInputValue(v) → 'HH:MM'|''`, `nextStartValue(picked, initialRaw) → string|null`, `nextDateValue(picked, todayYmd) → string|null`, `sheetDateText(ymd, todayYmd)`, `setupMinutesText(proposal)`, `extensionHint(proposal, hours) → string|null`, `multiShiftNote(count) → string|null`, `editableEvent(proposal, shifts, todayYmd) → boolean`, `editLockedReason(proposal) → string|null`, `sheetValuesOf(form) → SheetValues`, `fieldsChanged(a, b) → boolean`, `changedSinceOpen(openedAt, fresh) → boolean`, `confirmView({ proposal, preview, changed }) → View`, `saveErrorText(err) → string`, `curfewReason(err) → string|null`, `noteFirstLine(note) → string`. `SheetValues = { event_date: 'YYYY-MM-DD', event_start_time: string, event_duration_hours: number, guest_count: number }`. `View = { repriced: boolean, oldTotal: string, newTotal: string, balanceLine: string|null, lines: string[], button: 'Confirm new total'|'Done' }`.

- [ ] **Step 1: Write the failing tests**

Create `client/src/utils/editSheetView.test.js`:

```js
import '@testing-library/jest-dom';
import {
  stepHours, stepGuests, canStep, fmtHours, clampStart, startInputValue, nextStartValue, nextDateValue,
  sheetDateText, setupMinutesText, extensionHint, multiShiftNote, editableEvent, editLockedReason,
  sheetValuesOf, fieldsChanged, changedSinceOpen, confirmView, saveErrorText, curfewReason, noteFirstLine,
  NO_CONNECTION, LOCKED_NOTE,
} from './editSheetView';

describe('steppers', () => {
  test('duration moves in half hours, snapping an off-grid value, from 1 to 12', () => {
    expect(stepHours(4, 1)).toBe(4.5);
    expect(stepHours(4, -1)).toBe(3.5);
    expect(stepHours(4.25, 1)).toBe(4.5);
    expect(stepHours(4.25, -1)).toBe(4);
    expect(stepHours(1, -1)).toBe(1);
    expect(stepHours(12, 1)).toBe(12);
    expect(stepHours('5.5', 1)).toBe(6);
  });
  test('guests move in fives, landing on multiples of five, from 1 to 1000', () => {
    expect(stepGuests(140, 1)).toBe(145);
    expect(stepGuests(140, -1)).toBe(135);
    expect(stepGuests(137, 1)).toBe(140);
    expect(stepGuests(137, -1)).toBe(135);
    expect(stepGuests(1, 1)).toBe(5);
    expect(stepGuests(5, -1)).toBe(1);
    expect(stepGuests(1, -1)).toBe(1);
    expect(stepGuests(1000, 1)).toBe(1000);
  });
  test('canStep is false at a floor or a ceiling', () => {
    expect(canStep(1, -1, stepHours)).toBe(false);
    expect(canStep(12, 1, stepHours)).toBe(false);
    expect(canStep(4, 1, stepHours)).toBe(true);
    expect(canStep(1, -1, stepGuests)).toBe(false);
  });
  test('fmtHours shows the half hour', () => {
    expect(fmtHours(4)).toBe('4 hr');
    expect(fmtHours(4.5)).toBe('4.5 hr');
    expect(fmtHours('5.0')).toBe('5 hr');
  });
});

describe('start time', () => {
  test('clampStart holds 06:00 to 23:30, as the desktop picker does', () => {
    expect(clampStart('05:15')).toBe('06:00');
    expect(clampStart('23:45')).toBe('23:30');
    expect(clampStart('19:05')).toBe('19:05');
    expect(clampStart('nonsense')).toBeNull();
  });
  test('startInputValue reads any stored shape as HH:MM, or blank', () => {
    expect(startInputValue('7:00 PM')).toBe('19:00');
    expect(startInputValue('18:00')).toBe('18:00');
    expect(startInputValue('')).toBe('');
    expect(startInputValue('evening')).toBe('');
  });
  test('nextStartValue keeps the stored value for the same time', () => {
    expect(nextStartValue('19:00', '7:00 PM')).toBe('7:00 PM');
    expect(nextStartValue('19:30', '7:00 PM')).toBe('19:30');
    expect(nextStartValue('04:00', '7:00 PM')).toBe('06:00');
    expect(nextStartValue('', '7:00 PM')).toBeNull();
  });
});

test('nextDateValue takes a real date from today on, and nothing earlier', () => {
  expect(nextDateValue('2026-10-06', '2026-10-05')).toBe('2026-10-06');
  expect(nextDateValue('2026-10-05', '2026-10-05')).toBe('2026-10-05');
  expect(nextDateValue('2026-10-04', '2026-10-05')).toBeNull();
  expect(nextDateValue('', '2026-10-05')).toBeNull();
});

test('sheetDateText is the rail date, with the year outside the current one', () => {
  expect(sheetDateText('2026-08-15', '2026-03-01')).toBe('SAT AUG 15');
  expect(sheetDateText('2027-01-09', '2026-03-01')).toBe('SAT JAN 09 2027');
  expect(sheetDateText('', '2026-03-01')).toBe('');
});

test('setupMinutesText keeps the minutes before, from the detail setup line', () => {
  expect(setupMinutesText({ setup_time_display: '17:15', event_start_time: '18:00' })).toBe('45 min before');
  expect(setupMinutesText({ setup_time_display: '17:15', event_start_time: 'later' })).toBe('from 17:15');
  expect(setupMinutesText({})).toBe('');
});

test('extensionHint is the desktop line, only after a settled extension', () => {
  expect(extensionHint({ settled_extension_hours: 1, contract_floor_hours: 3 }, 5))
    .toBe('Includes 1h of on-site extension, billed on its own invoice. The contract prices 4h.');
  expect(extensionHint({ settled_extension_hours: 1, contract_floor_hours: 4 }, 4.5))
    .toBe('Includes 1h of on-site extension, billed on its own invoice. The contract prices 4h.');
  expect(extensionHint({ settled_extension_hours: 0 }, 5)).toBeNull();
});

test('multiShiftNote speaks only for more than one shift', () => {
  expect(multiShiftNote(2)).toBe('This event has 2 shifts. Changing the date or time here does not move them; each shift is edited from desktop view.');
  expect(multiShiftNote(1)).toBeNull();
  expect(multiShiftNote(0)).toBeNull();
});

describe('which events the phone edits', () => {
  const live = { status: 'deposit_paid', event_date: '2026-10-10T00:00:00.000Z' };
  test('archived and completed never', () => {
    expect(editableEvent({ ...live, status: 'archived' }, null, '2026-10-05')).toBe(false);
    expect(editableEvent({ ...live, status: 'completed' }, null, '2026-10-05')).toBe(false);
  });
  test('with a roster, a shift not yet finished decides', () => {
    expect(editableEvent(live, { state: 'ready', rows: [{ status: 'open', finished: true }] }, '2026-10-05')).toBe(false);
    expect(editableEvent(live, { state: 'ready', rows: [{ status: 'open', finished: true }, { status: 'open', finished: false }] }, '2026-10-05')).toBe(true);
    expect(editableEvent(live, { state: 'ready', rows: [{ status: 'cancelled', finished: false }] }, '2026-10-05')).toBe(false);
  });
  test('without a roster, the Chicago date decides', () => {
    expect(editableEvent(live, { state: 'loading', rows: [] }, '2026-10-05')).toBe(true);
    expect(editableEvent(live, { state: 'ready', rows: [] }, '2026-10-11')).toBe(false);
    expect(editableEvent({ ...live, event_date: null }, null, '2026-10-05')).toBe(false);
  });
  test('editLockedReason: a fresh read that went archived or completed', () => {
    expect(editLockedReason({ status: 'archived' })).toBe(LOCKED_NOTE);
    expect(editLockedReason({ status: 'completed' })).toBe(LOCKED_NOTE);
    expect(editLockedReason({ status: 'balance_paid' })).toBeNull();
  });
});

test('sheetValuesOf and fieldsChanged compare what the sheet edits', () => {
  const v = sheetValuesOf({ event_date: '2026-10-10', event_start_time: '7:00 PM', event_duration_hours: '5', guest_count: '140', venue_name: 'x' });
  expect(v).toEqual({ event_date: '2026-10-10', event_start_time: '7:00 PM', event_duration_hours: 5, guest_count: 140 });
  expect(fieldsChanged(v, { ...v })).toBe(false);
  expect(fieldsChanged(v, { ...v, event_start_time: '19:00' })).toBe(false);
  expect(fieldsChanged(v, { ...v, event_start_time: '19:30' })).toBe(true);
  expect(fieldsChanged(v, { ...v, event_duration_hours: 5.5 })).toBe(true);
  expect(fieldsChanged(v, { ...v, guest_count: 145 })).toBe(true);
  expect(fieldsChanged(v, { ...v, event_date: '2026-10-11' })).toBe(true);
});

test('changedSinceOpen compares updated_at as stored', () => {
  expect(changedSinceOpen('2026-10-01T10:00:00.000Z', { updated_at: '2026-10-01T10:00:00.000Z' })).toBe(false);
  expect(changedSinceOpen('2026-10-01T10:00:00.000Z', { updated_at: '2026-10-01T10:05:00.000Z' })).toBe(true);
});

describe('confirmView', () => {
  const booked = {
    status: 'deposit_paid', total_price: '3650.00', amount_paid: '1900.00', off_contract_paid_cents: 0,
    gratuity_rate_change_origin: null, pricing_snapshot: { gratuity: { total: 120 } },
  };
  test('nothing changed: Done, no total, whatever today’s catalog says', () => {
    const v = confirmView({ proposal: booked, preview: { total: 3700, gratuityTotal: 120 }, changed: false });
    expect(v).toMatchObject({ repriced: false, button: 'Done', balanceLine: null, lines: [] });
  });
  test('changed but the total held: Done, no lines', () => {
    const v = confirmView({ proposal: booked, preview: { total: 3650, gratuityTotal: 120 }, changed: true });
    expect(v).toMatchObject({ repriced: false, button: 'Done', lines: [] });
  });
  test('a booked reprice: the totals, the balance line and the desktop lines', () => {
    const v = confirmView({ proposal: booked, preview: { total: 3800, gratuityTotal: 120 }, changed: true });
    expect(v.repriced).toBe(true);
    expect(v.button).toBe('Confirm new total');
    expect(v.oldTotal).toBe('$3,650.00');
    expect(v.newTotal).toBe('$3,800.00');
    expect(v.balanceLine).toBe('balance due becomes $1,900.00');
    expect(v.lines[v.lines.length - 1]).toBe('Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.');
  });
  test('the balance never reads below $0', () => {
    const v = confirmView({ proposal: { ...booked, amount_paid: '3700.00' }, preview: { total: 3500, gratuityTotal: 120 }, changed: true });
    expect(v.balanceLine).toBe('balance due becomes $0.00');
  });
  test('an unbooked reprice shows the totals and nothing else', () => {
    const v = confirmView({ proposal: { ...booked, status: 'accepted', amount_paid: '0' }, preview: { total: 3800, gratuityTotal: 120 }, changed: true });
    expect(v).toMatchObject({ repriced: true, balanceLine: null, lines: [] });
  });
  test('the gratuity line arrives through the shared summary', () => {
    const v = confirmView({ proposal: booked, preview: { total: 3700, gratuityTotal: 160 }, changed: true });
    expect(v.lines).toContain('The gratuity rises to $160.00, so the client is emailed the new amount automatically, unless email to them is turned off.');
  });
});

describe('errors', () => {
  test('a transport failure reads as no connection', () => {
    expect(saveErrorText({ status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' })).toBe(NO_CONNECTION);
  });
  test('a refusal shows its field text, never the generic line', () => {
    expect(saveErrorText({ status: 400, message: 'Please fix the errors below', fieldErrors: { guest_count: 'Hosted packages require at least 25 guests' } }))
      .toBe('Hosted packages require at least 25 guests');
  });
  test('anything else shows the server message', () => {
    expect(saveErrorText({ status: 500, message: 'Something broke' })).toBe('Something broke');
    expect(saveErrorText({ status: 500 })).toBe('Something went wrong. Try again.');
  });
  test('curfewReason reads the past_curfew refusal, and nothing else', () => {
    expect(curfewReason({ fieldErrors: { past_curfew: 'true', event_duration_hours: 'Ends at 2:30 AM, past curfew.' } })).toBe('Ends at 2:30 AM, past curfew.');
    expect(curfewReason({ fieldErrors: { past_curfew: 'true' } })).toBe('This booking runs past our 2:00 AM service curfew.');
    expect(curfewReason({ fieldErrors: { guest_count: 'x' } })).toBeNull();
    expect(curfewReason(null)).toBeNull();
  });
});

test('noteFirstLine is the first line with text, trimmed', () => {
  expect(noteFirstLine('\n  Gate code at the barn  \nsecond')).toBe('Gate code at the barn');
  expect(noteFirstLine('')).toBe('');
  expect(noteFirstLine(null)).toBe('');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/editSheetView.test.js`
Expected: FAIL with "Cannot find module './editSheetView'".

- [ ] **Step 3: Export dollars from eventDetailView.js**

In `client/src/utils/eventDetailView.js`, change `function dollars(n) {` to `export function dollars(n) {` (nothing else).

- [ ] **Step 4: Write editSheetView.js**

Create `client/src/utils/editSheetView.js`:

```js
// Pure view-model for the phone edit sheet (lane ma-e3; spec
// 2026-08-13-mobile-admin section 3, "Brainstorm decisions of 2026-10-05";
// benchmark 2026-09-15, Edit details and the edit sheet). No React, no fetch.
// The money lines come from the desktop's own buildRepriceSummary, so both
// surfaces say the same thing from one copy.
import { buildRepriceSummary, BOOKED_STATUSES } from '../pages/admin/proposalEditor/repriceSummary';
import { dollars, setupOf } from './eventDetailView';
import { railParts } from './eventCards';
import { fmtTime24 } from '../components/adminos/format';

export const HOURS_MIN = 1;
export const HOURS_MAX = 12;
export const GUESTS_MIN = 1;
export const GUESTS_MAX = 1000;
export const START_MIN = '06:00';
export const START_MAX = '23:30';
export const SHEET_NOTE = 'event edit · reprices the booking';
export const STALE_EVENT = 'This event changed since you opened it.';
export const PREVIEW_FAILED = "Couldn't price the change.";
export const NO_CONNECTION = "No connection, didn't save.";
export const LOCKED_NOTE = 'This event can no longer be edited here. Use desktop view.';
const GENERIC = 'Something went wrong. Try again.';
const CURFEW_DEFAULT = 'This booking runs past our 2:00 AM service curfew.';

// Half hours (Dallas, 2026-10-05: the half hours must be visible). A stored
// off-grid value (4.25) lands on the grid on its first step.
export function stepHours(value, dir) {
  const v = Number(value) || 0;
  const next = dir > 0 ? Math.floor(v * 2) / 2 + 0.5 : Math.ceil(v * 2) / 2 - 0.5;
  return Math.min(HOURS_MAX, Math.max(HOURS_MIN, next));
}

// Fives, landing on multiples of five, so 137 steps to 140 or 135.
export function stepGuests(value, dir) {
  const v = Math.round(Number(value) || 0);
  const next = dir > 0 ? Math.floor(v / 5) * 5 + 5 : Math.ceil(v / 5) * 5 - 5;
  return Math.min(GUESTS_MAX, Math.max(GUESTS_MIN, next));
}

export const canStep = (value, dir, step) => step(value, dir) !== Number(value);
export const fmtHours = (value) => `${String(Number(value))} hr`;

const minutesOf = (hhmm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const hhmmOf = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

// The desktop editor's start picker runs 06:00 through 23:30 (TimePicker,
// minHour 6, maxHour 23, last slot :30).
export function clampStart(value) {
  const mins = minutesOf(String(value || '').slice(0, 5));
  if (mins === null) return null;
  return hhmmOf(Math.min(minutesOf(START_MAX), Math.max(minutesOf(START_MIN), mins)));
}

// The native time input takes HH:MM. Stored start times come in several
// shapes ("7:00 PM" from server-side creation, "18:00" from the editor).
export function startInputValue(value) {
  const t = fmtTime24(value);
  return /^\d{2}:\d{2}$/.test(t) ? t : '';
}

// The value the form takes for a picked time. Picking the time the event
// already has keeps the stored value as stored, so an unchanged time is never
// sent in a new shape (which would read as a reschedule).
export function nextStartValue(picked, initialRaw) {
  const clamped = clampStart(picked);
  if (!clamped) return null;
  return clamped === startInputValue(initialRaw) ? initialRaw : clamped;
}

// A real date, today (Chicago) or later. Moving an upcoming event into the
// past is a desktop job.
export function nextDateValue(picked, todayYmd) {
  const ymd = String(picked || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return ymd >= todayYmd ? ymd : null;
}

// "SAT AUG 15", the rail's words, with the year when it is not this one.
export function sheetDateText(ymd, todayYmd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return '';
  const r = railParts(ymd);
  if (!r.day) return '';
  const year = ymd.slice(0, 4) !== String(todayYmd || '').slice(0, 4) ? ` ${ymd.slice(0, 4)}` : '';
  return `${r.dow} ${r.mon} ${r.day}${year}`;
}

// "45 min before", from the detail's own setup line (setupOf).
export function setupMinutesText(proposal) {
  const line = setupOf(proposal);
  if (!line) return '';
  const at = line.indexOf(' · ');
  return at >= 0 ? line.slice(at + 3) : line;
}

// The desktop editor's hint, word for word (ProposalEditorForm, Duration).
export function extensionHint(proposal, hours) {
  const settled = Number(proposal?.settled_extension_hours) || 0;
  if (!(settled > 0)) return null;
  const contract = Math.max(Number(proposal.contract_floor_hours) || 0, (Number(hours) || 0) - settled);
  return `Includes ${settled}h of on-site extension, billed on its own invoice. The contract prices ${contract}h.`;
}

// The save moves a shift with the event only when the event has exactly one
// (eventCreation.js syncShiftsFromProposal).
export function multiShiftNote(count) {
  return count > 1
    ? `This event has ${count} shifts. Changing the date or time here does not move them; each shift is edited from desktop view.`
    : null;
}

// Upcoming and live (spec section 3, 2026-10-05). The server knows a shift's
// end instant (`finished`); without a roster, the event's date against
// Chicago's today stands in for it.
export function editableEvent(proposal, shifts, todayYmd) {
  const p = proposal || {};
  if (p.status === 'archived' || p.status === 'completed') return false;
  if (shifts && shifts.state === 'ready' && Array.isArray(shifts.rows) && shifts.rows.length > 0) {
    return shifts.rows.some((s) => s.status !== 'cancelled' && !s.finished);
  }
  const ymd = String(p.event_date || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) && ymd >= todayYmd;
}

// The sheet's fresh read can find the event closed since the row was drawn.
export function editLockedReason(proposal) {
  const s = proposal && proposal.status;
  return s === 'archived' || s === 'completed' ? LOCKED_NOTE : null;
}

// The four fields the sheet edits, out of the desktop form.
export function sheetValuesOf(form) {
  return {
    event_date: form.event_date,
    event_start_time: form.event_start_time,
    event_duration_hours: Number(form.event_duration_hours),
    guest_count: Number(form.guest_count),
  };
}

export function fieldsChanged(a, b) {
  if (!a || !b) return false;
  return a.event_date !== b.event_date
    || fmtTime24(a.event_start_time) !== fmtTime24(b.event_start_time)
    || Number(a.event_duration_hours) !== Number(b.event_duration_hours)
    || Number(a.guest_count) !== Number(b.guest_count);
}

// updated_at moves on every UPDATE of the row (schema.sql trigger
// update_proposals_updated_at), so any write since the sheet opened shows here.
export function changedSinceOpen(openedAt, fresh) {
  return String((fresh && fresh.updated_at) || '') !== String(openedAt || '');
}

// What the sheet shows under the steppers. Nothing until a field changed: an
// untouched sheet closes with "Done" and sends nothing, even when today's
// catalog would price the event differently.
export function confirmView({ proposal, preview, changed }) {
  const p = proposal || {};
  const oldNum = Number(p.total_price) || 0;
  const none = { repriced: false, oldTotal: dollars(oldNum), newTotal: dollars(oldNum), balanceLine: null, lines: [], button: 'Done' };
  if (!changed || !preview) return none;
  const newNum = Number(preview.total);
  if (!Number.isFinite(newNum) || Math.abs(newNum - oldNum) < 0.005) return none;
  const booked = BOOKED_STATUSES.includes(p.status);
  const summary = buildRepriceSummary({
    status: p.status,
    totalPrice: p.total_price,
    amountPaid: p.amount_paid,
    newTotal: newNum,
    offContractPaidCents: p.off_contract_paid_cents,
    gratuityOrigin: p.gratuity_rate_change_origin,
    oldGratuityTotal: p.pricing_snapshot && p.pricing_snapshot.gratuity ? p.pricing_snapshot.gratuity.total : null,
    newGratuityTotal: preview.gratuityTotal,
  });
  const paid = Number(p.amount_paid) || 0;
  return {
    repriced: true,
    oldTotal: dollars(oldNum),
    newTotal: dollars(newNum),
    balanceLine: booked ? `balance due becomes ${dollars(Math.max(0, newNum - paid))}` : null,
    lines: summary && !summary.unknown ? summary.lines : [],
    button: 'Confirm new total',
  };
}

// A refusal's reason lives in fieldErrors; the message of a ValidationError
// is the generic "Please fix the errors below".
export function saveErrorText(err) {
  if (!err || err.status === 0 || err.code === 'NETWORK_ERROR') return NO_CONNECTION;
  const texts = Object.entries(err.fieldErrors || {})
    .filter(([k, v]) => k !== 'past_curfew' && typeof v === 'string' && v.trim())
    .map(([, v]) => v);
  return texts.length ? texts.join(' ') : (err.message || GENERIC);
}

// The past_curfew refusal (crud.js curfew gate): its reason rides on
// event_duration_hours.
export function curfewReason(err) {
  const fe = (err && err.fieldErrors) || {};
  if (!fe.past_curfew) return null;
  return fe.event_duration_hours || CURFEW_DEFAULT;
}

export function noteFirstLine(note) {
  return String(note || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/editSheetView.test.js src/utils/eventDetailView.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/utils/editSheetView.js client/src/utils/editSheetView.test.js client/src/utils/eventDetailView.js
git commit -m "feat(phone): the edit sheet's view-model, steppers, start and date rules, confirm lines, errors"
```

### Task 3: The edit sheet: reads, steppers, preview, save, curfew, changed since open

**Files:**
- Create: `client/src/components/mobile/useEditSheet.js`
- Create: `client/src/components/mobile/EditSheet.js`
- Create: `client/src/components/mobile/EditSheet.test.js`
- Modify: `client/src/index.css` (the stepper and edit-sheet rules, in the mobile block after the `.m-fail` family)
- Modify: `client/src/utils/mobileClassContract.test.js` (add `components/mobile/EditSheet.js` to `SOURCES`)

**Interfaces:**
- Consumes: Task 1 (`editorCore.js`, `patchBody.js`, `notifyDrafts.js`), Task 2 (`editSheetView.js`), `formState.js`, `useSheetFocus`, `useToast`, `api`.
- Produces: `useEditSheet({ proposalId, onSaved, previewDelayMs = 400 })` returning `{ phase: 'loading'|'failed'|'locked'|'ready', proposal, lockedMessage, values, initial, setValue(field, value), preview: { state: 'loading'|'ready'|'failed', total, gratuityTotal }, retryPreview(), view, changed, busy, error, curfew, stale, pending, drafts, staff, setStaff(next), canSend, confirm(), sendUpdate(), dontSend(), backToEdit(), toggleChannel(i, ch), acknowledgeCurfew(), declineCurfew(), reload() }`; `LOAD_FAILED`, `CURFEW_DECLINED`. `EditSheet({ proposalId, clientName, kind, shiftCount = 0, onClose, onSaved, previewDelayMs })`.

- [ ] **Step 1: Write the failing tests**

Create `client/src/components/mobile/EditSheet.test.js`:

```js
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import EditSheet from './EditSheet';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));

const PKG = { id: 1, slug: 'the-core-reaction', name: 'The Core Reaction', pricing_type: 'flat', bar_type: 'service_only', guests_per_bartender: 100 };
const BARBACK = { id: 7, slug: 'barback', billing_type: 'per_hour', minimum_hours: 0 };
// 140 guests at 100 per bartender needs 2; 3 stored is a charged override.
// The barback row was priced at 4 hours, 2 barbacks: quantity 8.
const PROPOSAL = {
  id: 13, status: 'deposit_paid', client_name: 'Alexis Henderson', event_type: 'wedding-reception',
  event_date: '2999-08-15T00:00:00.000Z', event_start_time: '7:00 PM', event_duration_hours: '4',
  guest_count: 140, package_id: 1, num_bars: 0, num_bartenders: 3,
  venue_name: 'Grove', venue_street: '12 River Rd', venue_city: 'Rockford', venue_state: 'Illinois', venue_zip: '61101',
  total_price: '3650.00', amount_paid: '1900.00', off_contract_paid_cents: 0, client_signed_at: '2999-01-01T00:00:00.000Z',
  setup_time_display: '18:15', setup_minutes_before: null, settled_extension_hours: 0, contract_floor_hours: null,
  adjustments: [], total_price_override: null, client_provides_glassware: false, class_options: null,
  addons: [{ addon_id: 7, quantity: 8, rate: 25, line_total: 200, variant: null }],
  pricing_snapshot: { total: 3650, gratuity: { rate: 10, tip_jar: true, total: 120 }, syrups: { selections: [] } },
  gratuity_rate_change_origin: null, updated_at: '2999-07-01T10:00:00.000Z',
};
const NETWORK = { status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' };

function serve({ proposal = PROPOSAL, reread = null, calculate = { total: 3650, gratuity: { total: 120 } }, notices = [], patch } = {}) {
  let proposalReads = 0;
  api.get.mockImplementation((url) => {
    if (url === '/proposals/13') {
      proposalReads += 1;
      const p = proposalReads > 1 && reread ? reread : proposal;
      return p.reject ? Promise.reject(p.reject) : Promise.resolve({ data: p });
    }
    if (url === '/proposals/packages') return Promise.resolve({ data: [PKG] });
    if (url === '/proposals/addons') return Promise.resolve({ data: [BARBACK] });
    return Promise.reject({ status: 404, message: 'Not found' });
  });
  api.post.mockImplementation((url) => {
    if (url === '/proposals/calculate') {
      const c = typeof calculate === 'function' ? calculate() : calculate;
      return c && c.reject ? Promise.reject(c.reject) : Promise.resolve({ data: c });
    }
    if (url === '/proposals/13/notify-preflight') return Promise.resolve({ data: { notices } });
    return Promise.reject({ status: 404 });
  });
  api.patch.mockImplementation(patch || (() => Promise.resolve({ data: { ...PROPOSAL, notifications: [] } })));
}

function mount(props = {}) {
  const onClose = jest.fn();
  const onSaved = jest.fn();
  render(<EditSheet proposalId={13} clientName="Alexis Henderson" kind="Wedding Reception" onClose={onClose} onSaved={onSaved} previewDelayMs={0} {...props} />);
  return { onClose, onSaved };
}
const ready = () => screen.findByText('Duration');
const more = (name) => fireEvent.click(screen.getByRole('button', { name }));
const confirmBtn = () => screen.getByRole('button', { name: /^(Confirm new total|Done)$/ });

beforeEach(() => { mockToast.success.mockReset(); mockToast.error.mockReset(); mockToast.info.mockReset(); });

test('reads the event and both catalogs fresh, never from the stored copy', async () => {
  serve();
  mount();
  await ready();
  expect(api.get).toHaveBeenCalledWith('/proposals/13');
  expect(api.get).toHaveBeenCalledWith('/proposals/packages');
  expect(api.get).toHaveBeenCalledWith('/proposals/addons');
  for (const call of api.get.mock.calls) expect(call).toHaveLength(1);
});

test('the head, the rows as drawn, the stored values, and Setup with no arrow', async () => {
  serve();
  mount();
  await ready();
  expect(screen.getByRole('dialog', { name: 'Edit details' })).toBeInTheDocument();
  expect(screen.getByText('event edit · reprices the booking')).toBeInTheDocument();
  expect(screen.getByText('THU AUG 15 2999')).toBeInTheDocument();
  expect(screen.getByLabelText('Start')).toHaveValue('19:00');
  expect(screen.getByText('4 hr')).toBeInTheDocument();
  expect(screen.getByText('140')).toBeInTheDocument();
  expect(screen.getByText('45 min before')).toBeInTheDocument();
  // eslint-disable-next-line testing-library/no-node-access
  expect(screen.getByText('Setup').closest('.m-sheet-row').querySelector('.m-edit-caret')).toBeNull();
});

test('duration steps in half hours and guests in fives, and the floors hold', async () => {
  serve();
  mount();
  await ready();
  more('Longer');
  expect(screen.getByText('4.5 hr')).toBeInTheDocument();
  more('More guests');
  expect(screen.getByText('145')).toBeInTheDocument();
  for (let i = 0; i < 12; i += 1) more('Shorter');
  expect(screen.getByText('1 hr')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Shorter' })).toBeDisabled();
});

test('an untouched sheet says Done and closes without a request', async () => {
  serve({ calculate: { total: 3700, gratuity: { total: 120 } } });
  const { onClose } = mount();
  await ready();
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/proposals/calculate', expect.any(Object)));
  expect(screen.queryByText('New total')).toBeNull();
  fireEvent.click(confirmBtn());
  expect(onClose).toHaveBeenCalled();
  expect(api.patch).not.toHaveBeenCalled();
});

test('a change asks the server for the new total and shows the booked lines', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }) });
  mount();
  await ready();
  more('More guests');
  expect(await screen.findByText('New total')).toBeInTheDocument();
  expect(screen.getByText('$3,650.00')).toBeInTheDocument();
  expect(screen.getByText('$3,800.00')).toBeInTheDocument();
  expect(screen.getByText('balance due becomes $1,900.00')).toBeInTheDocument();
  expect(screen.getByText('Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.')).toBeInTheDocument();
  expect(confirmBtn()).toHaveTextContent('Confirm new total');
  const body = api.post.mock.calls.filter(([u]) => u === '/proposals/calculate').pop()[1];
  expect(body).toMatchObject({ proposal_id: 13, guest_count: 145, duration_hours: 4, num_bartenders: 3, addon_quantities: { 7: 2 } });
  expect(body).not.toHaveProperty('gratuity_mandate_total');
});

test('a failed figure keeps Confirm disabled and Retry asks again', async () => {
  let fail = true;
  serve({ calculate: () => (fail ? { reject: NETWORK } : { total: 3800, gratuity: { total: 120 } }) });
  mount();
  await ready();
  more('More guests');
  expect(await screen.findByText("Couldn't price the change.")).toBeInTheDocument();
  expect(confirmBtn()).toBeDisabled();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  expect(screen.getByText('$3,800.00')).toBeInTheDocument();
});

test('the save sends the desktop\'s complete payload, without the venue keys', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }) });
  const { onSaved } = mount();
  await ready();
  more('More guests');
  more('Longer');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await waitFor(() => expect(api.patch).toHaveBeenCalled());
  const [url, body] = api.patch.mock.calls[0];
  expect(url).toBe('/proposals/13');
  expect(body).toMatchObject({
    event_date: '2999-08-15', event_start_time: '7:00 PM', event_duration_hours: 4.5, guest_count: 145,
    package_id: 1, num_bars: 0, num_bartenders: 3, addon_ids: [7], addon_quantities: { 7: 2 },
    syrup_selections: [], adjustments: [], total_price_override: null, setup_minutes_before: null,
    class_options: null, client_provides_glassware: false, notify: [],
  });
  for (const k of ['venue_name', 'venue_street', 'venue_city', 'venue_state', 'venue_zip', 'gratuity_mandate_total', 'notify_assigned_staff']) {
    expect(body).not.toHaveProperty(k);
  }
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(mockToast.success).toHaveBeenCalledWith('Event updated.');
});

test('an untouched start time is sent as stored', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }) });
  mount();
  await ready();
  fireEvent.change(screen.getByLabelText('Start'), { target: { value: '19:00' } });
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await waitFor(() => expect(api.patch).toHaveBeenCalled());
  expect(api.patch.mock.calls[0][1].event_start_time).toBe('7:00 PM');
});

test('a changed start time goes out as HH:MM, clamped to the desktop picker', async () => {
  serve();
  mount();
  await ready();
  fireEvent.change(screen.getByLabelText('Start'), { target: { value: '23:50' } });
  expect(screen.getByLabelText('Start')).toHaveValue('23:30');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await waitFor(() => expect(api.patch).toHaveBeenCalled());
  expect(api.patch.mock.calls[0][1].event_start_time).toBe('23:30');
});

test('the date picker starts at today and ignores an earlier date', async () => {
  serve();
  mount();
  await ready();
  const input = screen.getByLabelText('Date');
  expect(input).toHaveAttribute('min', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  fireEvent.change(input, { target: { value: '2000-01-01' } });
  expect(input).toHaveValue('2999-08-15');
  fireEvent.change(input, { target: { value: '2999-08-22' } });
  expect(screen.getByText('THU AUG 22 2999')).toBeInTheDocument();
});

test('a second tap while a save is in flight sends nothing', async () => {
  let release;
  serve({
    calculate: () => ({ total: 3800, gratuity: { total: 120 } }),
    patch: () => new Promise((resolve) => { release = () => resolve({ data: { notifications: [] } }); }),
  });
  mount();
  await ready();
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await screen.findByText('Saving');
  fireEvent.click(confirmBtn());
  fireEvent.click(confirmBtn());
  release();
  await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
  expect(api.patch).toHaveBeenCalledTimes(1);
});

test('an event that moved since the sheet opened is not saved', async () => {
  serve({
    calculate: () => ({ total: 3800, gratuity: { total: 120 } }),
    reread: { ...PROPOSAL, updated_at: '2999-07-01T10:05:00.000Z', event_duration_hours: '5' },
  });
  mount();
  await ready();
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  expect(await screen.findByText('This event changed since you opened it.')).toBeInTheDocument();
  expect(api.patch).not.toHaveBeenCalled();
  expect(confirmBtn()).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(await screen.findByText('5 hr')).toBeInTheDocument();
  expect(screen.getByText('140')).toBeInTheDocument();
});

test('past the curfew: the server reason, then Book it anyway resends acknowledged', async () => {
  let calls = 0;
  serve({
    patch: () => {
      calls += 1;
      return calls === 1
        ? Promise.reject({ status: 400, message: 'Please fix the errors below', fieldErrors: { past_curfew: 'true', event_duration_hours: 'This booking ends at 2:30 AM, past the 2:00 AM curfew.' } })
        : Promise.resolve({ data: { notifications: [] } });
    },
  });
  const { onSaved } = mount();
  await ready();
  more('Longer');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  expect(await screen.findByText('This booking ends at 2:30 AM, past the 2:00 AM curfew. Book it anyway? This will be recorded.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Book it anyway' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.patch.mock.calls[1][1].acknowledge_past_curfew).toBe(true);
  expect(api.get.mock.calls.filter(([u]) => u === '/proposals/13')).toHaveLength(3);
});

test('Keep editing at the curfew leaves the desktop line and saves nothing', async () => {
  serve({ patch: () => Promise.reject({ status: 400, fieldErrors: { past_curfew: 'true' } }) });
  mount();
  await ready();
  more('Longer');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
  expect(screen.getByText('Not saved. The end time is past our 2:00 AM service curfew.')).toBeInTheDocument();
  expect(api.patch).toHaveBeenCalledTimes(1);
});

test('a refusal shows the server\'s text and the sheet stays open', async () => {
  serve({ patch: () => Promise.reject({ status: 400, message: 'Please fix the errors below', fieldErrors: { guest_count: 'Hosted packages require at least 25 guests' } }) });
  const { onSaved, onClose } = mount();
  await ready();
  more('Fewer guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  expect(await screen.findByText('Hosted packages require at least 25 guests')).toBeInTheDocument();
  expect(onSaved).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

test('a dropped connection on the save says so', async () => {
  serve({ patch: () => Promise.reject(NETWORK) });
  mount();
  await ready();
  more('Fewer guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  expect(await screen.findByText("No connection, didn't save.")).toBeInTheDocument();
});

test('the reads failing say so, with Retry', async () => {
  serve({ proposal: { reject: NETWORK } });
  mount();
  expect(await screen.findByText("Couldn't load this event. Editing needs a connection.")).toBeInTheDocument();
  serve();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await ready();
});

test('an event closed since the row was drawn is not editable here', async () => {
  serve({ proposal: { ...PROPOSAL, status: 'completed' } });
  mount();
  expect(await screen.findByText('This event can no longer be edited here. Use desktop view.')).toBeInTheDocument();
  expect(screen.queryByText('Duration')).toBeNull();
});

test('the extension hint and the multi-shift note', async () => {
  serve({ proposal: { ...PROPOSAL, settled_extension_hours: 1, contract_floor_hours: 3 } });
  mount({ shiftCount: 2 });
  await ready();
  expect(screen.getByText('Includes 1h of on-site extension, billed on its own invoice. The contract prices 3h.')).toBeInTheDocument();
  expect(screen.getByText('This event has 2 shifts. Changing the date or time here does not move them; each shift is edited from desktop view.')).toBeInTheDocument();
});

test('Cancel closes, and the scrim does nothing while a save is in flight', async () => {
  let release;
  serve({ patch: () => new Promise((resolve) => { release = () => resolve({ data: { notifications: [] } }); }) });
  const { onClose } = mount();
  await ready();
  more('Longer');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await screen.findByText('Saving');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).not.toHaveBeenCalled();
  release();
  await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
});
```

Note on the "past the curfew" test: three proposal reads are expected, the open, the re-read before the first PATCH, and the re-read before the acknowledged PATCH (every PATCH re-reads first).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/mobile/EditSheet.test.js`
Expected: FAIL with "Cannot find module './EditSheet'".

- [ ] **Step 3: Write useEditSheet.js**

Create `client/src/components/mobile/useEditSheet.js`:

```js
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { initialFormFromProposal, recoverAddonQuantities, pricedDurationHours } from '../../pages/admin/proposalEditor/formState';
import { buildProposalPatchBody, staffNotifyFlags } from '../../pages/admin/proposalEditor/patchBody';
import {
  detectNumBartendersOverride, storedGratuityOf, isClassPackageFor, buildCalculateBody,
} from '../../pages/admin/proposalEditor/editorCore';
import { initialDrafts, buildNotifyEntries, draftsOverCap, noticeOutcomes } from '../comms/notifyDrafts';
import {
  confirmView, fieldsChanged, changedSinceOpen, saveErrorText, curfewReason, sheetValuesOf, editLockedReason,
} from '../../utils/editSheetView';

// Everything the phone edit sheet (lane ma-e3) reads and writes; EditSheet.js
// draws. Spec 2026-08-13-mobile-admin section 3, brainstorm decisions of
// 2026-10-05.
//
// Reads are FRESH: plain api.get, which the admin service worker neither
// stores nor answers (only offlineRead.js asks it to). A money sheet never
// opens on a stored copy (spec section 7).
//
// The save sends the desktop editor's complete payload (buildProposalPatchBody)
// on the desktop editor's own form state (initialFormFromProposal,
// recoverAddonQuantities, the override detection), with the four sheet fields
// replaced: the PATCH treats a missing add-on list as "delete every add-on"
// and a missing override as "drop it". It leaves out the venue keys (the sheet
// never edits location), never sends the gratuity mandate, never writes the
// client contact.
//
// One write at a time (a ref: a double tap sends one request). Every PATCH
// re-reads the event first and refuses when its updated_at moved since the
// sheet opened (the on-site-extension overwrite).
export const LOAD_FAILED = "Couldn't load this event. Editing needs a connection.";
export const CURFEW_DECLINED = 'Not saved. The end time is past our 2:00 AM service curfew.';
const NO_STAFF = { enabled: false, sms: false, email: false };

export default function useEditSheet({ proposalId, onSaved, previewDelayMs = 400 }) {
  const toast = useToast();
  const [load, setLoad] = useState({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [values, setValues] = useState(null);
  const [preview, setPreview] = useState({ state: 'loading' });
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState(null);
  const [curfew, setCurfew] = useState(null);
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [staff, setStaff] = useState(NO_STAFF);
  const handlers = useRef({ onSaved });
  handlers.current = { onSaved };

  useEffect(() => {
    let gone = false;
    setLoad({ phase: 'loading' });
    setValues(null); setError(null); setStale(false); setCurfew(null); setPending(null);
    Promise.all([
      api.get(`/proposals/${proposalId}`),
      api.get('/proposals/packages'),
      api.get('/proposals/addons'),
    ]).then(([pRes, pkgRes, addonRes]) => {
      if (gone) return;
      const proposal = pRes.data || {};
      const locked = editLockedReason(proposal);
      if (locked) { setLoad({ phase: 'locked', proposal, message: locked }); return; }
      const packages = Array.isArray(pkgRes.data) ? pkgRes.data : [];
      const addons = Array.isArray(addonRes.data) ? addonRes.data : [];
      const form = initialFormFromProposal(proposal);
      form.addon_quantities = recoverAddonQuantities(proposal.addons, addons, { durationHours: pricedDurationHours(proposal) });
      const selectedPkg = packages.find((p) => p.id === Number(form.package_id));
      const base = {
        proposal,
        form,
        initial: sheetValuesOf(form),
        override: detectNumBartendersOverride(proposal, packages),
        isClass: isClassPackageFor(selectedPkg, proposal),
        gratuity: storedGratuityOf(proposal),
        openedAt: proposal.updated_at,
      };
      setValues(base.initial);
      setLoad({ phase: 'ready', base });
    }).catch(() => { if (!gone) setLoad({ phase: 'failed' }); });
    return () => { gone = true; };
  }, [proposalId, attempt]);

  const base = load.phase === 'ready' ? load.base : null;
  const formNow = useMemo(() => (base && values ? { ...base.form, ...values } : null), [base, values]);

  // The server's own calculator, asked again whenever a priced field moves.
  // Numbered, so a late answer never describes a form it no longer matches.
  const seq = useRef(0);
  const guests = values ? values.guest_count : null;
  const hours = values ? values.event_duration_hours : null;
  useEffect(() => {
    if (!base) return undefined;
    seq.current += 1;
    const mine = seq.current;
    setPreview({ state: 'loading' });
    const timer = setTimeout(() => {
      api.post('/proposals/calculate', buildCalculateBody(
        { ...base.form, guest_count: guests, event_duration_hours: hours },
        {
          proposalId: base.proposal.id,
          numBartendersOverride: base.override,
          tipJar: base.gratuity.tipJar,
          gratuityRate: base.gratuity.rate,
          includeMandate: false,
        },
      ))
        .then((res) => {
          if (mine !== seq.current) return;
          const snap = res.data || {};
          setPreview({ state: 'ready', total: snap.total, gratuityTotal: snap.gratuity ? snap.gratuity.total : null });
        })
        .catch(() => { if (mine === seq.current) setPreview({ state: 'failed' }); });
    }, previewDelayMs);
    return () => clearTimeout(timer);
  }, [base, guests, hours, previewAttempt, previewDelayMs]);

  const changed = !!(base && values && fieldsChanged(base.initial, values));
  const view = base
    ? confirmView({ proposal: base.proposal, preview: preview.state === 'ready' ? preview : null, changed })
    : null;

  const setValue = useCallback((field, value) => {
    setValues((cur) => (cur ? { ...cur, [field]: value } : cur));
    setError(null);
  }, []);

  // Every PATCH re-reads first and refuses when the event moved since the
  // sheet opened. A curfew refusal is held for the inline confirm.
  const saveChecked = useCallback(async (body, notify, staffChoice) => {
    const fresh = await api.get(`/proposals/${base.proposal.id}`);
    if (changedSinceOpen(base.openedAt, fresh.data)) { setStale(true); setPending(null); return; }
    const payload = { ...body, ...(staffChoice ? staffNotifyFlags(staffChoice) : {}), notify };
    try {
      const res = await api.patch(`/proposals/${base.proposal.id}`, payload);
      toast.success('Event updated.');
      noticeOutcomes(res.data && res.data.notifications).forEach((o) => toast[o.kind](o.text));
      if (handlers.current.onSaved) handlers.current.onSaved();
    } catch (err) {
      const reason = curfewReason(err);
      if (reason && !body.acknowledge_past_curfew) {
        setPending(null);
        setCurfew({ reason, body, notify, staff: staffChoice });
        return;
      }
      throw err;
    }
  }, [base, toast]);

  const run = useCallback(async (fn) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(saveErrorText(err)); } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const confirm = useCallback(() => run(async () => {
    if (!base || !formNow) return;
    const body = buildProposalPatchBody(formNow, {
      isClassPackage: base.isClass,
      numBartendersOverride: base.override,
      includeGratuityMandate: false,
      includeVenue: false,
    });
    const pre = await api.post(`/proposals/${base.proposal.id}/notify-preflight`, body);
    const notices = pre.data && Array.isArray(pre.data.notices) ? pre.data.notices : [];
    if (notices.length > 0) {
      setDrafts(initialDrafts(notices));
      setStaff(NO_STAFF);
      setPending({ body, notices });
      return;
    }
    await saveChecked(body, [], null);
  }), [run, base, formNow, saveChecked]);

  const sendUpdate = useCallback(() => run(async () => {
    if (!pending) return;
    await saveChecked(pending.body, buildNotifyEntries(pending.notices, drafts), staff);
  }), [run, pending, drafts, staff, saveChecked]);

  const dontSend = useCallback(() => run(async () => {
    if (!pending) return;
    await saveChecked(pending.body, [], staff);
  }), [run, pending, staff, saveChecked]);

  const backToEdit = useCallback(() => { if (!busyRef.current) setPending(null); }, []);

  const toggleChannel = useCallback((i, ch) => {
    setDrafts((cur) => cur.map((d, j) => (j !== i ? d : {
      ...d,
      channels: d.channels.includes(ch) ? d.channels.filter((c) => c !== ch) : [...d.channels, ch],
    })));
  }, []);

  const acknowledgeCurfew = useCallback(() => run(async () => {
    if (!curfew) return;
    const held = curfew;
    setCurfew(null);
    await saveChecked({ ...held.body, acknowledge_past_curfew: true }, held.notify, held.staff);
  }), [run, curfew, saveChecked]);

  const declineCurfew = useCallback(() => { setCurfew(null); setError(CURFEW_DECLINED); }, []);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const retryPreview = useCallback(() => setPreviewAttempt((n) => n + 1), []);

  return {
    phase: load.phase,
    proposal: base ? base.proposal : (load.proposal || null),
    lockedMessage: load.message || null,
    values,
    initial: base ? base.initial : null,
    setValue,
    preview,
    retryPreview,
    view,
    changed,
    busy,
    error,
    curfew,
    stale,
    pending,
    drafts,
    staff,
    setStaff,
    canSend: !!pending && drafts.some((d) => d.channels.length > 0) && !draftsOverCap(pending.notices, drafts),
    confirm,
    sendUpdate,
    dontSend,
    backToEdit,
    toggleChannel,
    acknowledgeCurfew,
    declineCurfew,
    reload,
  };
}
```

- [ ] **Step 4: Write EditSheet.js (the edit view; Task 4 adds the notify view)**

Create `client/src/components/mobile/EditSheet.js`:

```js
import React, { useRef } from 'react';
import useSheetFocus from '../../hooks/useSheetFocus';
import Icon from '../adminos/Icon';
import { ctDay } from '../adminos/format';
import useEditSheet, { LOAD_FAILED } from './useEditSheet';
import {
  SHEET_NOTE, STALE_EVENT, PREVIEW_FAILED, START_MIN, START_MAX,
  stepHours, stepGuests, canStep, fmtHours, startInputValue, nextStartValue, nextDateValue,
  sheetDateText, setupMinutesText, extensionHint, multiShiftNote,
} from '../../utils/editSheetView';

// The phone edit sheet for an EVENT (lane ma-e3; spec 2026-08-13-mobile-admin
// section 3, brainstorm decisions of 2026-10-05; benchmark 2026-09-15, the
// edit sheet). This file draws; useEditSheet.js reads and writes. Mounted
// only while open; the owner holds the URL state (useDrawerParam, push).
export default function EditSheet({ proposalId, clientName, kind, shiftCount = 0, onClose, onSaved, previewDelayMs }) {
  const sheet = useEditSheet({ proposalId, onSaved, previewDelayMs });
  const sheetRef = useRef(null);
  const closers = useRef({});
  closers.current = { onClose: () => { if (!sheet.busy && onClose) onClose(); } };
  useSheetFocus(sheetRef, closers);

  const today = ctDay(new Date());
  const ready = sheet.phase === 'ready' && !!sheet.values;
  const v = sheet.values || {};
  const view = sheet.view;
  const confirmLabel = view ? view.button : 'Done';
  const canConfirm = ready && !sheet.busy && !sheet.curfew && !sheet.stale
    && (!sheet.changed || sheet.preview.state === 'ready');
  const onConfirm = () => { if (sheet.changed) sheet.confirm(); else closers.current.onClose(); };
  const hint = ready ? extensionHint(sheet.proposal, v.event_duration_hours) : null;
  const shiftsNote = multiShiftNote(shiftCount);

  const stepper = (label, value, text, step, field, lessName, moreName) => (
    <div className="m-sheet-row m-edit-stepper-row">
      <span className="m-edit-label">{label}</span>
      <span className="m-stepper-ctl">
        <button type="button" className="m-stepper-btn" aria-label={lessName}
          disabled={sheet.busy || !canStep(value, -1, step)}
          onClick={() => sheet.setValue(field, step(value, -1))}>{String.fromCharCode(0x2212)}</button>
        <span className="m-stepper-value">{text}</span>
        <button type="button" className="m-stepper-btn" aria-label={moreName}
          disabled={sheet.busy || !canStep(value, 1, step)}
          onClick={() => sheet.setValue(field, step(value, 1))}>+</button>
      </span>
    </div>
  );

  return (
    <>
      <button type="button" className="m-sheet-scrim" aria-label="Close" tabIndex={-1}
        onClick={() => closers.current.onClose()} />
      <div className="m-sheet" role="dialog" aria-modal="true" aria-label="Edit details" tabIndex={-1} ref={sheetRef}>
        <div className="m-sheet-handle" />
        <div className="m-sheet-head">
          <h2 className="m-sheet-title">{clientName || 'Event'}{kind ? <span className="m-sheet-kind">{` · ${kind}`}</span> : null}</h2>
          <div className="m-sheet-mix">{SHEET_NOTE}</div>
        </div>
        <div className={`m-sheet-body${sheet.busy ? ' m-sheet-busy' : ''}`}>
          {sheet.phase === 'loading' && <div className="m-sheet-state">Loading the event</div>}
          {sheet.phase === 'failed' && (
            <div className="m-fail" role="alert">
              <span className="m-fail-msg">{LOAD_FAILED}</span>
              <button type="button" className="m-fail-retry" onClick={sheet.reload}>Retry</button>
            </div>
          )}
          {sheet.phase === 'locked' && <div className="m-sheet-state">{sheet.lockedMessage}</div>}
          {ready && !sheet.pending && (
            <>
              <label className="m-sheet-row m-edit-pick">
                <Icon name="calendar" size={18} />
                <span className="m-edit-label">Date</span>
                <span className="m-edit-value">{sheetDateText(v.event_date, today)}</span>
                <span className="m-edit-caret" aria-hidden="true"><Icon name="right" size={16} /></span>
                <input type="date" className="m-edit-native" aria-label="Date" value={v.event_date || ''}
                  min={today} disabled={sheet.busy}
                  onChange={(e) => { const next = nextDateValue(e.target.value, today); if (next) sheet.setValue('event_date', next); }} />
              </label>
              <label className="m-sheet-row m-edit-pick">
                <Icon name="clock" size={18} />
                <span className="m-edit-label">Start</span>
                <span className="m-edit-value">{startInputValue(v.event_start_time)}</span>
                <span className="m-edit-caret" aria-hidden="true"><Icon name="right" size={16} /></span>
                <input type="time" className="m-edit-native" aria-label="Start" step={300}
                  min={START_MIN} max={START_MAX} value={startInputValue(v.event_start_time)} disabled={sheet.busy}
                  onChange={(e) => {
                    const next = nextStartValue(e.target.value, sheet.initial.event_start_time);
                    if (next) sheet.setValue('event_start_time', next);
                  }} />
              </label>
              {stepper('Duration', v.event_duration_hours, fmtHours(v.event_duration_hours), stepHours, 'event_duration_hours', 'Shorter', 'Longer')}
              {hint && <div className="m-edit-hint">{hint}</div>}
              <div className="m-sheet-row m-edit-static">
                <span className="m-edit-label">Setup</span>
                <span className="m-edit-value">{setupMinutesText(sheet.proposal)}</span>
              </div>
              {stepper('Guests', v.guest_count, String(v.guest_count), stepGuests, 'guest_count', 'Fewer guests', 'More guests')}
              {shiftsNote && <div className="m-edit-hint">{shiftsNote}</div>}
              {view && view.repriced && (
                <div className="m-edit-total">
                  <span className="m-edit-total-label">New total</span>
                  <span className="m-edit-total-old">{view.oldTotal}</span>
                  <span className="m-edit-arrow" aria-hidden="true">{String.fromCharCode(0x2192)}</span>
                  <span className="m-edit-total-new">{view.newTotal}</span>
                </div>
              )}
              {view && view.balanceLine && <div className="m-edit-bal">{view.balanceLine}</div>}
              {view && view.lines.length > 0 && (
                <ul className="m-edit-lines">{view.lines.map((line) => <li key={line}>{line}</li>)}</ul>
              )}
              {sheet.changed && sheet.preview.state === 'failed' && (
                <div className="m-fail" role="alert">
                  <span className="m-fail-msg">{PREVIEW_FAILED}</span>
                  <button type="button" className="m-fail-retry" onClick={sheet.retryPreview}>Retry</button>
                </div>
              )}
              {sheet.stale && (
                <div className="m-sheet-note" role="alert">
                  <span className="m-sheet-note-dot" aria-hidden="true" />
                  <span className="m-sheet-note-text">{STALE_EVENT}</span>
                  <button type="button" className="m-fail-retry" onClick={sheet.reload}>Reload</button>
                </div>
              )}
              {sheet.curfew && (
                <div className="m-confirm" role="alert">
                  <div className="m-confirm-copy">{`${sheet.curfew.reason} Book it anyway? This will be recorded.`}</div>
                  <div className="m-confirm-btns">
                    <button type="button" className="m-act m-act-quiet" disabled={sheet.busy} onClick={sheet.declineCurfew}>Keep editing</button>
                    <button type="button" className="m-act m-act-primary" disabled={sheet.busy} onClick={sheet.acknowledgeCurfew}>Book it anyway</button>
                  </div>
                </div>
              )}
              {sheet.error && (
                <div className="m-fail" role="alert"><span className="m-fail-msg">{sheet.error}</span></div>
              )}
            </>
          )}
        </div>
        {sheet.busy && <div className="m-saving" role="status">Saving</div>}
        {ready && !sheet.pending && (
          <div className="m-acts">
            <button type="button" className="m-act m-act-quiet" disabled={sheet.busy} onClick={() => closers.current.onClose()}>Cancel</button>
            <button type="button" className="m-act m-act-primary" disabled={!canConfirm} onClick={onConfirm}>{confirmLabel}</button>
          </div>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 5: Add the CSS**

In `client/src/index.css`, inside the mobile block, directly after the `.m-fail` family (the last `.m-fail*` rule), add:

```css
/* Edit sheet (lane ma-e3; benchmark 2026-09-15, the edit sheet). The stepper is
   the design system's (components-mobile.css), folded; the value is wider than
   drawn so "4.5 hr" fits. A date or time row carries its native input across the
   whole row, transparent, so a tap anywhere opens the phone's own picker. */
html[data-app="admin-os"] .m-stepper-ctl { display: flex; align-items: center; flex: none; background: var(--bg-3); border: 1px solid var(--line-2); border-radius: var(--radius); }
html[data-app="admin-os"] .m-stepper-btn { min-width: 44px; min-height: 44px; background: none; border: none; color: var(--ink-1); font-size: 18px; font-family: var(--font-mono); cursor: pointer; }
html[data-app="admin-os"] .m-stepper-btn:disabled { color: var(--ink-4); cursor: default; }
html[data-app="admin-os"] .m-stepper-value { min-width: 56px; text-align: center; font-family: var(--font-numeric); font-size: 15px; color: var(--ink-1); }
html[data-app="admin-os"] .m-edit-pick { position: relative; }
html[data-app="admin-os"] .m-edit-pick:focus-within { outline: 2px solid var(--accent); outline-offset: -2px; }
html[data-app="admin-os"] .m-edit-native { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; opacity: 0; cursor: pointer; }
html[data-app="admin-os"] .m-edit-label { flex: 1; }
html[data-app="admin-os"] .m-edit-value { flex: none; font-family: var(--font-numeric); font-size: 12.5px; color: var(--ink-2); }
html[data-app="admin-os"] .m-edit-caret { flex: none; display: flex; color: var(--ink-4); }
html[data-app="admin-os"] .m-sheet-row.m-edit-static,
html[data-app="admin-os"] .m-sheet-row.m-edit-stepper-row { cursor: default; }
html[data-app="admin-os"] .m-edit-hint { padding: 0 16px 10px; font-size: 11px; line-height: 1.45; color: var(--ink-3); }
html[data-app="admin-os"] .m-edit-total { border-top: 1px solid var(--line-2); padding: 10px 16px; display: flex; align-items: center; gap: 8px; }
html[data-app="admin-os"] .m-edit-total-label { flex: 1; font-size: var(--fs-body); font-weight: 600; color: var(--ink-1); }
html[data-app="admin-os"] .m-edit-total-old { font-family: var(--font-numeric); font-size: 12.5px; color: var(--ink-3); }
html[data-app="admin-os"] .m-edit-arrow { color: var(--ink-4); }
html[data-app="admin-os"] .m-edit-total-new { font-family: var(--font-numeric); font-size: 12.5px; font-weight: 600; color: var(--ink-1); }
html[data-app="admin-os"] .m-edit-bal { padding: 0 16px 8px; text-align: right; font-family: var(--font-numeric); font-size: 11px; color: var(--ink-3); }
html[data-app="admin-os"] .m-edit-lines { margin: 0 16px 10px; padding: 0 0 0 16px; font-size: 11px; line-height: 1.5; color: var(--ink-2); }
html[data-app="admin-os"] .m-edit-lines li + li { margin-top: 4px; }
html[data-app="admin-os"][data-skin="light"] .m-stepper-ctl { border-radius: 0; border-color: var(--line-2); }
```

In `client/src/utils/mobileClassContract.test.js`, add `'components/mobile/EditSheet.js',` to `SOURCES`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/mobile/EditSheet.test.js src/utils/mobileClassContract.test.js`
Expected: PASS, every test.

- [ ] **Step 7: CI build and commit**

Run: `cd client && CI=true npx react-scripts build`
Expected: exit 0.

```bash
git add client/src/components/mobile/useEditSheet.js client/src/components/mobile/EditSheet.js client/src/components/mobile/EditSheet.test.js client/src/index.css client/src/utils/mobileClassContract.test.js
git commit -m "feat(phone): the edit sheet, fresh reads, half-hour and five-guest steppers, the shared preview, the desktop payload, curfew and changed-since-open"
```

### Task 4: The notify step

**Files:**
- Modify: `client/src/components/mobile/EditSheet.js` (render the notify view when `sheet.pending`)
- Modify: `client/src/components/mobile/EditSheet.test.js` (append)
- Modify: `client/src/index.css` (the notify rules, after Task 3's block)

**Interfaces:**
- Consumes: `sheet.pending = { body, notices }`, `sheet.drafts`, `sheet.staff`, `sheet.setStaff`, `sheet.canSend`, `sheet.toggleChannel`, `sheet.sendUpdate`, `sheet.dontSend`, `sheet.backToEdit` (Task 3); `humanizeReason` (Task 1).
- Produces: the second view of `EditSheet`.

- [ ] **Step 1: Write the failing tests**

Append to `client/src/components/mobile/EditSheet.test.js`:

```js
const NOTICE = {
  type: 'event_details', composable: true, reasons: ['event_date changed'],
  recipient: { name: 'Alexis Henderson', email: 'alexis.hend@gmail.com', phone: '+13125550184' },
  channels: { email: { available: true, default: true }, sms: { available: true, default: true } },
  autopay_notice: null,
  draft: { email: { subject: 'Your event date changed', body_text: 'Hi Alexis, your event is now on Aug 22.' }, sms: { body: 'Your event moved to Aug 22.' } },
};

async function toNotifyStep(over = {}) {
  serve({ notices: [NOTICE], ...over });
  const handles = mount();
  await ready();
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2999-08-22' } });
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await screen.findByText('Notify the client?');
  return handles;
}

test('a booked date change opens the desktop notify step: channels ticked as the desktop ticks them, the message read-only', async () => {
  await toNotifyStep();
  expect(screen.getByText('Date changed. Current contact on file: Alexis Henderson (alexis.hend@gmail.com).')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Email' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Text' })).toBeChecked();
  expect(screen.getByText('Your event date changed')).toBeInTheDocument();
  expect(screen.getByText('Hi Alexis, your event is now on Aug 22.')).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('checkbox', { name: 'Notify assigned staff' })).not.toBeChecked();
  expect(screen.getByText('Staff are notified only when the date, time, or location actually changes.')).toBeInTheDocument();
  const buttons = screen.getAllByRole('button').map((b) => b.textContent);
  expect(buttons.slice(-3)).toEqual(['Cancel', 'Send the update', "Don't send"]);
  expect(screen.getByRole('button', { name: "Don't send" })).toHaveClass('m-act-primary');
});

test('Don\'t send saves with no notice and the staff choice off', async () => {
  const { onSaved } = await toNotifyStep();
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.patch.mock.calls[0][1]).toMatchObject({
    event_date: '2999-08-22', notify: [], notify_assigned_staff: false, notify_staff_sms: false, notify_staff_email: false,
  });
});

test('Send the update sends the standard text on the ticked channels, and the staff choice', async () => {
  const { onSaved } = await toNotifyStep();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Text' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Notify assigned staff' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Text the assigned staff' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send the update' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.patch.mock.calls[0][1]).toMatchObject({
    notify: [{ type: 'event_details', channels: ['email'], email: { subject: 'Your event date changed', body_text: 'Hi Alexis, your event is now on Aug 22.' } }],
    notify_assigned_staff: true, notify_staff_sms: true, notify_staff_email: false,
  });
});

test('a second tap on Send the update sends one PATCH', async () => {
  let release;
  await toNotifyStep({ patch: () => new Promise((resolve) => { release = () => resolve({ data: { notifications: [] } }); }) });
  fireEvent.click(screen.getByRole('button', { name: 'Send the update' }));
  await screen.findByText('Saving');
  fireEvent.click(screen.getByRole('button', { name: 'Send the update' }));
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  release();
  await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
  expect(api.patch).toHaveBeenCalledTimes(1);
});

test('Cancel goes back to the edit with the change kept and nothing saved', async () => {
  await toNotifyStep();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(await screen.findByText('THU AUG 22 2999')).toBeInTheDocument();
  expect(api.patch).not.toHaveBeenCalled();
});

test('a client with no email and no phone: both unavailable, Send disabled, Don\'t send still saves', async () => {
  const bare = {
    ...NOTICE,
    recipient: { name: 'Alexis Henderson', email: null, phone: null },
    channels: {
      email: { available: false, default: false, unavailable_reason: 'No email on file.' },
      sms: { available: false, default: false, unavailable_reason: 'No usable phone on file.' },
    },
  };
  const { onSaved } = await toNotifyStep({ notices: [bare] });
  expect(screen.getByText('Email unavailable: No email on file.')).toBeInTheDocument();
  expect(screen.getByText('Text unavailable: No usable phone on file.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send the update' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.patch.mock.calls[0][1].notify).toEqual([]);
});

test('unticking every channel disables Send the update', async () => {
  await toNotifyStep();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Email' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Text' }));
  expect(screen.getByRole('button', { name: 'Send the update' })).toBeDisabled();
});

test('the outcome toasts the desktop shows', async () => {
  const { onSaved } = await toNotifyStep({
    patch: () => Promise.resolve({ data: { notifications: [{ email: 'failed', email_error: 'bounced', sms: 'sent' }] } }),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send the update' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(mockToast.success).toHaveBeenCalledWith('Event updated.');
  expect(mockToast.error).toHaveBeenCalledWith('Saved, but the email failed: bounced');
});

test('the event moving while the notify step was open is caught at the send', async () => {
  await toNotifyStep({ reread: { ...PROPOSAL, updated_at: '2999-07-01T10:09:00.000Z' } });
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  expect(await screen.findByText('This event changed since you opened it.')).toBeInTheDocument();
  expect(api.patch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/mobile/EditSheet.test.js -t "notify|Don't send|Send the update|Cancel goes back|no email|unticking|outcome toasts|moving while"`
Expected: FAIL (no "Notify the client?" on screen).

- [ ] **Step 3: Render the notify view**

In `client/src/components/mobile/EditSheet.js`:
1. Add the import `import { humanizeReason } from '../comms/notifyDrafts';`.
2. Add this component at the bottom of the file:

```js
// The desktop notify popup, mirrored (spec section 3, 2026-10-05): the same
// ticks, the standard message read-only, the staff block off by default.
function NotifyStep({ sheet }) {
  const { pending, drafts, staff, busy } = sheet;
  return (
    <div className="m-notify">
      <h3 className="m-notify-title">Notify the client?</h3>
      {pending.notices.map((n, i) => {
        const d = drafts[i] || { channels: [], subject: '', bodyText: '', smsBody: '' };
        const r = n.recipient || {};
        const contact = r.email ? ` (${r.email})` : (r.phone ? ` (${r.phone})` : '');
        return (
          <div key={n.type} className="m-notify-notice">
            <div className="m-notify-reasons">
              {`${(n.reasons || []).map(humanizeReason).join(', ')}. Current contact on file: ${r.name || 'the client'}${contact}.`}
            </div>
            {n.autopay_notice && <div className="m-notify-autopay">{n.autopay_notice}</div>}
            <div className="m-notify-channels">
              {['email', 'sms'].map((ch) => {
                const c = (n.channels || {})[ch];
                const label = ch === 'email' ? 'Email' : 'Text';
                if (c && c.available) {
                  return (
                    <label key={ch} className="m-notify-check">
                      <input type="checkbox" checked={d.channels.includes(ch)} disabled={busy}
                        onChange={() => sheet.toggleChannel(i, ch)} />
                      <span>{label}</span>
                    </label>
                  );
                }
                return c && c.unavailable_reason
                  ? <span key={ch} className="m-notify-unavail">{`${label} unavailable: ${c.unavailable_reason}`}</span>
                  : null;
              })}
            </div>
            {n.composable ? (
              <>
                {d.channels.includes('email') && (
                  <div className="m-notify-msg">
                    <div className="m-notify-subject">{d.subject}</div>
                    <div className="m-notify-body">{d.bodyText}</div>
                  </div>
                )}
                {d.channels.includes('sms') && (
                  <div className="m-notify-msg"><div className="m-notify-body">{d.smsBody}</div></div>
                )}
              </>
            ) : <div className="m-notify-fixed">This message is not editable.</div>}
          </div>
        );
      })}
      <div className="m-notify-staff">
        <label className="m-notify-check">
          <input type="checkbox" checked={staff.enabled} disabled={busy}
            onChange={(e) => sheet.setStaff(e.target.checked ? { ...staff, enabled: true } : { enabled: false, sms: false, email: false })} />
          <span>Notify assigned staff</span>
        </label>
        <div className="m-notify-sub">
          <label className="m-notify-check">
            <input type="checkbox" aria-label="Text the assigned staff" checked={staff.sms} disabled={busy || !staff.enabled}
              onChange={(e) => sheet.setStaff({ ...staff, sms: e.target.checked })} />
            <span>Text (SMS)</span>
          </label>
          <label className="m-notify-check">
            <input type="checkbox" aria-label="Email the assigned staff" checked={staff.email} disabled={busy || !staff.enabled}
              onChange={(e) => sheet.setStaff({ ...staff, email: e.target.checked })} />
            <span>Email</span>
          </label>
        </div>
        <div className="m-notify-hint">Staff are notified only when the date, time, or location actually changes.</div>
      </div>
    </div>
  );
}
```

3. In the body, after the `{ready && !sheet.pending && ( ... )}` block, add:
```js
          {ready && sheet.pending && <NotifyStep sheet={sheet} />}
          {ready && sheet.pending && sheet.error && (
            <div className="m-fail" role="alert"><span className="m-fail-msg">{sheet.error}</span></div>
          )}
```
4. After the edit view's `m-acts` footer, add the notify footer (the order puts "Don't send" rightmost, as the desktop's `primary="quiet"` does):
```js
        {ready && sheet.pending && (
          <div className="m-acts">
            <button type="button" className="m-act m-act-quiet" disabled={sheet.busy} onClick={sheet.backToEdit}>Cancel</button>
            <button type="button" className="m-act m-act-quiet" disabled={sheet.busy || !sheet.canSend} onClick={sheet.sendUpdate}>Send the update</button>
            <button type="button" className="m-act m-act-primary" disabled={sheet.busy} onClick={sheet.dontSend}>Don't send</button>
          </div>
        )}
```

- [ ] **Step 4: Add the notify CSS**

In `client/src/index.css`, after Task 3's block, add:

```css
/* The notify step (lane ma-e3): the desktop popup's content, in the sheet. */
html[data-app="admin-os"] .m-notify { padding: 12px 16px 6px; }
html[data-app="admin-os"] .m-notify-title { margin: 0 0 8px; font-size: var(--fs-body); font-weight: 600; font-family: var(--font-ui); color: var(--ink-1); }
html[data-app="admin-os"] .m-notify-notice + .m-notify-notice { border-top: 1px solid var(--line-1); margin-top: 10px; padding-top: 10px; }
html[data-app="admin-os"] .m-notify-reasons { font-size: var(--fs-meta); color: var(--ink-2); line-height: 1.5; }
html[data-app="admin-os"] .m-notify-autopay { margin-top: 8px; padding: 8px 10px; border: 1px solid var(--line-2); border-radius: var(--radius); font-size: var(--fs-meta); color: var(--ink-1); line-height: 1.5; }
html[data-app="admin-os"] .m-notify-channels { display: flex; flex-wrap: wrap; gap: 0 16px; margin-top: 4px; }
html[data-app="admin-os"] .m-notify-check { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; font-size: var(--fs-body); color: var(--ink-1); cursor: pointer; }
html[data-app="admin-os"] .m-notify-check input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
html[data-app="admin-os"] .m-notify-unavail { display: inline-flex; align-items: center; min-height: 44px; font-size: var(--fs-meta); color: var(--ink-3); }
html[data-app="admin-os"] .m-notify-msg { margin-top: 6px; padding: 8px 10px; border: 1px solid var(--line-1); border-radius: var(--radius); background: var(--bg-2); max-height: 160px; overflow-y: auto; }
html[data-app="admin-os"] .m-notify-subject { margin-bottom: 4px; font-size: var(--fs-meta); font-weight: 600; color: var(--ink-1); }
html[data-app="admin-os"] .m-notify-body { font-size: var(--fs-meta); color: var(--ink-2); line-height: 1.5; white-space: pre-wrap; }
html[data-app="admin-os"] .m-notify-fixed { margin-top: 6px; font-size: var(--fs-meta); color: var(--ink-3); }
html[data-app="admin-os"] .m-notify-staff { margin-top: 12px; padding-top: 6px; border-top: 1px solid var(--line-1); }
html[data-app="admin-os"] .m-notify-sub { display: flex; gap: 16px; padding-left: 26px; }
html[data-app="admin-os"] .m-notify-hint { padding: 0 0 6px 26px; font-size: 11px; color: var(--ink-3); line-height: 1.45; }
html[data-app="admin-os"][data-skin="light"] .m-notify-autopay,
html[data-app="admin-os"][data-skin="light"] .m-notify-msg { border-radius: 0; }
```

- [ ] **Step 5: Run the whole sheet suite and the class contract**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/mobile/EditSheet.test.js src/utils/mobileClassContract.test.js`
Expected: PASS, every test.

- [ ] **Step 6: CI build and commit**

Run: `cd client && CI=true npx react-scripts build`
Expected: exit 0.

```bash
git add client/src/components/mobile/EditSheet.js client/src/components/mobile/EditSheet.test.js client/src/index.css
git commit -m "feat(phone): the edit sheet's notify step, mirroring the desktop popup with Don't send as the main button"
```

### Task 5: The note sheet

**Files:**
- Create: `client/src/components/mobile/NoteSheet.js`
- Create: `client/src/components/mobile/NoteSheet.test.js`
- Modify: `client/src/index.css` (the note rules, after Task 4's block)
- Modify: `client/src/utils/mobileClassContract.test.js` (add `components/mobile/NoteSheet.js` to `SOURCES`)

**Interfaces:**
- Consumes: `saveErrorText` (Task 2), `useSheetFocus`, `api`.
- Produces: `NoteSheet({ proposalId, draft = null, onDraft(text|null), onSaved(note), onClose })`; `NOTE_LOAD_FAILED`, `NOTE_CHANGED`.

- [ ] **Step 1: Write the failing tests**

Create `client/src/components/mobile/NoteSheet.test.js`:

```js
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NoteSheet from './NoteSheet';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), patch: jest.fn() } }));

const NETWORK = { status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' };
function serve({ notes = ['Gate code 4412'], patch } = {}) {
  let reads = 0;
  api.get.mockImplementation(() => {
    const note = notes[Math.min(reads, notes.length - 1)];
    reads += 1;
    return note && note.reject ? Promise.reject(note.reject) : Promise.resolve({ data: { id: 13, admin_notes: note } });
  });
  api.patch.mockImplementation(patch || ((url, body) => Promise.resolve({ data: { id: 13, admin_notes: body.admin_notes } })));
}
function mount(props = {}) {
  const handles = { onDraft: jest.fn(), onSaved: jest.fn(), onClose: jest.fn() };
  const utils = render(<NoteSheet proposalId={13} {...handles} {...props} />);
  return { ...handles, ...utils };
}
const box = () => screen.findByRole('textbox', { name: 'Note' });

test('reads the note fresh and shows it in a 16px textarea, Save disabled until it changes', async () => {
  serve();
  mount();
  expect(await box()).toHaveValue('Gate code 4412');
  expect(api.get).toHaveBeenCalledWith('/proposals/13');
  expect(api.get.mock.calls[0]).toHaveLength(1);
  expect(screen.getByText('internal · never shown to staff or clients')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('Save re-reads, writes the note, and closes', async () => {
  serve();
  const { onSaved, onClose, onDraft } = mount();
  fireEvent.change(await box(), { target: { value: 'Gate code 4413' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(api.patch).toHaveBeenCalledWith('/proposals/13/notes', { admin_notes: 'Gate code 4413' });
  expect(onSaved).toHaveBeenCalledWith('Gate code 4413');
  expect(onDraft).toHaveBeenCalledWith(null);
  expect(api.get).toHaveBeenCalledTimes(2);
});

test('a note that changed meanwhile: yours is kept, theirs is shown, and you choose', async () => {
  serve({ notes: ['Gate code 4412', 'Call Marcus at the gate'] });
  const { onSaved } = mount();
  fireEvent.change(await box(), { target: { value: 'Gate code 4413' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('This note changed since you opened it.')).toBeInTheDocument();
  expect(screen.getByText('Call Marcus at the gate')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Gate code 4413');
  expect(api.patch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save mine' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('Gate code 4413'));
});

test('Discard mine takes their note and saves nothing', async () => {
  serve({ notes: ['Gate code 4412', 'Call Marcus at the gate'] });
  mount();
  fireEvent.change(await box(), { target: { value: 'Gate code 4413' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Discard mine' }));
  expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Call Marcus at the gate');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(api.patch).not.toHaveBeenCalled();
});

test('Back or the scrim keeps an unsaved draft; Cancel clears it', async () => {
  serve();
  const first = mount();
  fireEvent.change(await box(), { target: { value: 'Half written' } });
  first.unmount();
  expect(first.onDraft).toHaveBeenLastCalledWith('Half written');
  const second = mount();
  fireEvent.change(await box(), { target: { value: 'Something else' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(second.onDraft).toHaveBeenLastCalledWith(null);
  expect(second.onClose).toHaveBeenCalled();
  second.unmount();
  expect(second.onDraft).toHaveBeenLastCalledWith(null);
});

test('a kept draft reopens in place of the stored note', async () => {
  serve();
  mount({ draft: 'Half written' });
  expect(await box()).toHaveValue('Half written');
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
});

test('a read that fails says so, with Retry', async () => {
  serve({ notes: [{ reject: NETWORK }] });
  mount();
  expect(await screen.findByText("Couldn't load the note. Editing needs a connection.")).toBeInTheDocument();
  serve();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await box()).toHaveValue('Gate code 4412');
});

test('a save that fails says why and keeps the text', async () => {
  serve({ patch: () => Promise.reject(NETWORK) });
  mount();
  fireEvent.change(await box(), { target: { value: 'Gate code 4413' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText("No connection, didn't save.")).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Gate code 4413');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/mobile/NoteSheet.test.js`
Expected: FAIL with "Cannot find module './NoteSheet'".

- [ ] **Step 3: Write NoteSheet.js**

Create `client/src/components/mobile/NoteSheet.js`:

```js
import React, { useEffect, useRef, useState } from 'react';
import api from '../../utils/api';
import useSheetFocus from '../../hooks/useSheetFocus';
import { saveErrorText } from '../../utils/editSheetView';

// The internal booking note (proposals.admin_notes; lane ma-e3, spec section
// 3, brainstorm decisions of 2026-10-05): never shown to staff or clients, no
// money. Read fresh (plain api.get, never the stored copy), saved through
// PATCH /proposals/:id/notes after a re-read: a note that changed while the
// sheet was open is shown, and the text you wrote is kept until you choose.
// Back and the scrim keep an unsaved draft with the owner (onDraft); Cancel
// and a save clear it.
export const NOTE_LOAD_FAILED = "Couldn't load the note. Editing needs a connection.";
export const NOTE_CHANGED = 'This note changed since you opened it.';
const NOTE_MAX = 10000;

export default function NoteSheet({ proposalId, draft = null, onDraft, onSaved, onClose }) {
  const [phase, setPhase] = useState('loading');
  const [attempt, setAttempt] = useState(0);
  const [stored, setStored] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState(null);
  const [theirs, setTheirs] = useState(null);
  const textRef = useRef(null);
  const sheetRef = useRef(null);
  const settled = useRef(false);
  const latest = useRef({ text: '', stored: '', phase: 'loading' });
  latest.current = { text, stored, phase };
  const handlers = useRef({ onDraft });
  handlers.current = { onDraft };
  const closers = useRef({});
  closers.current = { onClose: () => { if (!busyRef.current && onClose) onClose(); } };
  useSheetFocus(sheetRef, closers);

  useEffect(() => {
    let gone = false;
    setPhase('loading');
    setError(null);
    api.get(`/proposals/${proposalId}`)
      .then((res) => {
        if (gone) return;
        const note = (res.data && res.data.admin_notes) || '';
        setStored(note);
        setText(draft != null ? draft : note);
        setPhase('ready');
      })
      .catch(() => { if (!gone) setPhase('failed'); });
    return () => { gone = true; };
    // The draft seeds the text at open only; a later draft is ours, not new input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposalId, attempt]);

  useEffect(() => { if (phase === 'ready' && textRef.current) textRef.current.focus(); }, [phase]);

  // Closed by Back or the scrim: keep what was written, if it differs.
  useEffect(() => () => {
    const l = latest.current;
    if (settled.current || l.phase !== 'ready' || !handlers.current.onDraft) return;
    handlers.current.onDraft(l.text !== l.stored ? l.text : null);
  }, []);

  const save = async (force) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!force) {
        const fresh = await api.get(`/proposals/${proposalId}`);
        const now = (fresh.data && fresh.data.admin_notes) || '';
        if (now !== stored) { setTheirs(now); return; }
      }
      const res = await api.patch(`/proposals/${proposalId}/notes`, { admin_notes: text });
      settled.current = true;
      if (onDraft) onDraft(null);
      if (onSaved) onSaved(res.data && res.data.admin_notes != null ? res.data.admin_notes : text);
      if (onClose) onClose();
    } catch (err) {
      setError(saveErrorText(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const saveMine = () => { setTheirs(null); save(true); };
  const discardMine = () => { setStored(theirs); setText(theirs); setTheirs(null); };
  const cancel = () => {
    if (busyRef.current) return;
    settled.current = true;
    if (onDraft) onDraft(null);
    if (onClose) onClose();
  };

  return (
    <>
      <button type="button" className="m-sheet-scrim" aria-label="Close" tabIndex={-1}
        onClick={() => closers.current.onClose()} />
      <div className="m-sheet" role="dialog" aria-modal="true" aria-label="Note" tabIndex={-1} ref={sheetRef}>
        <div className="m-sheet-handle" />
        <div className="m-sheet-head">
          <h2 className="m-sheet-title">Note</h2>
          <div className="m-sheet-mix">internal · never shown to staff or clients</div>
        </div>
        <div className={`m-sheet-body${busy ? ' m-sheet-busy' : ''}`}>
          {phase === 'loading' && <div className="m-sheet-state">Loading the note</div>}
          {phase === 'failed' && (
            <div className="m-fail" role="alert">
              <span className="m-fail-msg">{NOTE_LOAD_FAILED}</span>
              <button type="button" className="m-fail-retry" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
            </div>
          )}
          {phase === 'ready' && (
            <>
              <textarea ref={textRef} className="m-note-text" aria-label="Note" rows={8} maxLength={NOTE_MAX}
                value={text} disabled={busy} onChange={(e) => { setText(e.target.value); setError(null); }} />
              {theirs !== null && (
                <div className="m-note-conflict" role="alert">
                  <div className="m-confirm-copy">{NOTE_CHANGED}</div>
                  <div className="m-note-theirs">{theirs || 'The note is now empty.'}</div>
                  <div className="m-confirm-btns">
                    <button type="button" className="m-act m-act-quiet" disabled={busy} onClick={discardMine}>Discard mine</button>
                    <button type="button" className="m-act m-act-primary" disabled={busy} onClick={saveMine}>Save mine</button>
                  </div>
                </div>
              )}
              {error && <div className="m-fail" role="alert"><span className="m-fail-msg">{error}</span></div>}
            </>
          )}
        </div>
        {busy && <div className="m-saving" role="status">Saving</div>}
        <div className="m-acts">
          <button type="button" className="m-act m-act-quiet" disabled={busy} onClick={cancel}>Cancel</button>
          <button type="button" className="m-act m-act-primary"
            disabled={busy || phase !== 'ready' || theirs !== null || text === stored}
            onClick={() => save(false)}>Save</button>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Add the note CSS**

In `client/src/index.css`, after Task 4's block, add:

```css
/* The note sheet and row (lane ma-e3). 16px text: iOS zooms a field under 16px. */
html[data-app="admin-os"] .m-note-text { display: block; box-sizing: border-box; width: calc(100% - 32px); min-height: 160px; margin: 12px 16px 10px; padding: 10px 12px; resize: vertical; border: 1px solid var(--line-2); border-radius: var(--radius); background: var(--bg-3); color: var(--ink-1); font-family: var(--font-ui); font-size: 16px; line-height: 1.5; }
html[data-app="admin-os"] .m-note-text:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; }
html[data-app="admin-os"] .m-note-conflict { margin: 0 16px 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--line-2); border-radius: var(--radius); }
html[data-app="admin-os"] .m-note-theirs { max-height: 120px; overflow-y: auto; font-size: var(--fs-meta); color: var(--ink-2); line-height: 1.5; white-space: pre-wrap; }
html[data-app="admin-os"] .m-section-name.m-note-name { flex: none; }
html[data-app="admin-os"] .m-note-preview { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; font-size: var(--fs-meta); color: var(--ink-3); }
html[data-app="admin-os"][data-skin="light"] .m-note-text,
html[data-app="admin-os"][data-skin="light"] .m-note-conflict { border-radius: 0; }
```

In `client/src/utils/mobileClassContract.test.js`, add `'components/mobile/NoteSheet.js',` to `SOURCES`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/mobile/NoteSheet.test.js src/utils/mobileClassContract.test.js`
Expected: PASS.

- [ ] **Step 6: CI build and commit**

Run: `cd client && CI=true npx react-scripts build`
Expected: exit 0.

```bash
git add client/src/components/mobile/NoteSheet.js client/src/components/mobile/NoteSheet.test.js client/src/index.css client/src/utils/mobileClassContract.test.js
git commit -m "feat(phone): the note sheet for the internal booking note, with a kept draft and a changed-meanwhile choice"
```

### Task 6: Wire both sheets into the event detail

**Files:**
- Modify: `client/src/pages/mobile/EventDetailSections.js` (add `EditRow`, `NoteRow`)
- Modify: `client/src/pages/mobile/EventDetailPhone.js`
- Modify: `client/src/pages/mobile/EventDetailPhone.test.js`

**Interfaces:**
- Consumes: `EditSheet`, `NoteSheet` (Tasks 3 to 5); `editableEvent`, `noteFirstLine` (Task 2); `ctDay`; `api`.
- Produces: `EditRow({ mode: 'edit'|'desktop'|'offline', onEdit, onDesktop })`, `NoteRow({ note, offline, onOpen })`; the detail's `SHEETS = ['shift', 'edit', 'note']`.

- [ ] **Step 1: Write the failing tests**

In `client/src/pages/mobile/EventDetailPhone.test.js`:
1. Change the api mock to `jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));`.
2. Add two stubs after the AssignmentSheet stub:

```js
jest.mock('../../components/mobile/EditSheet', () => ({
  __esModule: true,
  default: ({ proposalId, shiftCount, onClose, onSaved }) => (
    <div data-testid="edit-sheet">
      <span data-testid="edit-id">{String(proposalId)}</span>
      <span data-testid="edit-shifts">{String(shiftCount)}</span>
      <button type="button" onClick={onClose}>stub edit close</button>
      <button type="button" onClick={onSaved}>stub edit saved</button>
    </div>
  ),
}));
jest.mock('../../components/mobile/NoteSheet', () => ({
  __esModule: true,
  default: ({ draft, onDraft, onSaved, onClose }) => (
    <div data-testid="note-sheet">
      <span data-testid="note-draft">{String(draft)}</span>
      <button type="button" onClick={() => onDraft('half written')}>stub note keep</button>
      <button type="button" onClick={() => onSaved('New note line')}>stub note saved</button>
      <button type="button" onClick={onClose}>stub note close</button>
    </div>
  ),
}));
```

3. Delete the test "Edit details opens the Desktop view of this screen" (`:599-607`): the default `PROPOSAL` is upcoming, so its row now opens the sheet, and the desktop path is proved by "a past event keeps desktop view" below. The test "on a cache-served read Edit details needs a connection and does nothing" stays as it is (the row still renders "needs connection" and calls nothing). The two archived tests stay as they are (no Edit details row on an archived event). Append:

```js
test('an upcoming event: Edit details reads date · time · guests and opens the edit sheet', async () => {
  serve();
  mount();
  await screen.findByText('Person 1');
  const row = screen.getByRole('button', { name: /^Edit details/ });
  expect(row).toHaveTextContent('date · time · guests');
  tap(row);
  expect(await screen.findByTestId('edit-sheet')).toBeInTheDocument();
  expect(screen.getByTestId('edit-id')).toHaveTextContent('13');
  expect(screen.getByTestId('edit-shifts')).toHaveTextContent('1');
  expect(screen.getByTestId('loc')).toHaveTextContent('/events/13?drawer=edit&drawerId=13');
  expect(mockMobileView.setDesktopView).not.toHaveBeenCalled();
});

test('a past event keeps desktop view', async () => {
  serve({ '/shifts/by-proposal/13': { data: [shift(1, { finished: true })] } });
  mount();
  await screen.findByText('Person 1');
  const row = screen.getByRole('button', { name: /^Edit details/ });
  expect(row).toHaveTextContent('desktop view');
  tap(row);
  expect(mockMobileView.setDesktopView).toHaveBeenCalledWith('event-detail', true);
  expect(screen.queryByTestId('edit-sheet')).toBeNull();
});

test('a stored copy: both rows read needs connection and open nothing', async () => {
  serve({ '/proposals/13': { data: PROPOSAL, staleAt: '2026-10-05T12:00:00.000Z' } });
  mount();
  await screen.findByText('Person 1');
  const edit = screen.getByRole('button', { name: /^Edit details/ });
  const note = screen.getByRole('button', { name: /^Note/ });
  expect(edit).toBeDisabled();
  expect(note).toBeDisabled();
  expect(edit).toHaveTextContent('needs connection');
  expect(note).toHaveTextContent('needs connection');
});

test('the Note row shows the first line or Add a note, and opens on a cancelled event too', async () => {
  serve({ '/proposals/13': { data: { ...PROPOSAL, status: 'archived', archive_reason: 'client_cancelled', admin_notes: '\nGate code 4412\nmore' } } });
  mount();
  await screen.findByText('Person 1');
  expect(screen.queryByRole('button', { name: /^Edit details/ })).toBeNull();
  const note = screen.getByRole('button', { name: /^Note/ });
  expect(note).toHaveTextContent('Gate code 4412');
  tap(note);
  expect(await screen.findByTestId('note-sheet')).toBeInTheDocument();
});

test('a note draft is kept between openings, and a save shows the new first line', async () => {
  serve();
  mount();
  await screen.findByText('Person 1');
  expect(screen.getByRole('button', { name: /^Note/ })).toHaveTextContent('Add a note');
  tap(screen.getByRole('button', { name: /^Note/ }));
  tap(await screen.findByText('stub note keep'));
  tap(screen.getByText('stub note close'));
  await waitFor(() => expect(screen.queryByTestId('note-sheet')).toBeNull());
  tap(screen.getByRole('button', { name: /^Note/ }));
  expect(await screen.findByTestId('note-draft')).toHaveTextContent('half written');
  tap(screen.getByText('stub note saved'));
  await waitFor(() => expect(screen.getByRole('button', { name: /^Note/ })).toHaveTextContent('New note line'));
});

test('after an edit save the sheet closes and the detail re-reads fresh, never a stored copy', async () => {
  serve();
  mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  tap(await screen.findByText('stub edit saved'));
  await waitFor(() => expect(screen.queryByTestId('edit-sheet')).toBeNull());
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/proposals/13'));
  expect(api.get).toHaveBeenCalledWith('/invoices/proposal/13');
});

test('a re-read after a save that fails says so, with Retry', async () => {
  let fail = false;
  serve({
    '/proposals/13': () => (fail ? { reject: NETWORK } : { data: PROPOSAL }),
  });
  mount({ initial: '/events/13?drawer=edit&drawerId=13' });
  await screen.findByText('stub edit saved');
  fail = true;
  tap(screen.getByText('stub edit saved'));
  expect(await screen.findByText('Saved. The event below could not be refreshed and may be out of date.')).toBeInTheDocument();
  fail = false;
  tap(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByText('Saved. The event below could not be refreshed and may be out of date.')).toBeNull());
});

test('an edit param for another event, or for a past event, is dropped', async () => {
  serve();
  mount({ initial: '/events/13?drawer=edit&drawerId=99' });
  await screen.findByText('Person 1');
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/));
  expect(screen.queryByTestId('edit-sheet')).toBeNull();
});
```

Note: the `serve` helper's table answers `api.get(url)` and `api.get(url, opts)` alike, so the fresh re-read (no options) and the first read (with `X-Offline-Ok`) are told apart by the call's arguments in the assertions above.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/mobile/EventDetailPhone.test.js`
Expected: FAIL on the new tests (no "date · time · guests", no Note row).

- [ ] **Step 3: Add EditRow and NoteRow to EventDetailSections.js**

In `client/src/pages/mobile/EventDetailSections.js`, add the import `import { noteFirstLine } from '../../utils/editSheetView';` and append:

```js
// The Edit details row (spec section 3, brainstorm decisions of 2026-10-05).
//   'edit'    an upcoming, live event on a fresh read: opens the edit sheet.
//   'desktop' a past event: opens the Desktop view, as before lane ma-e3.
//   'offline' a stored copy: "needs connection", and does nothing.
export function EditRow({ mode, onEdit, onDesktop }) {
  return (
    <section className="m-section">
      <button type="button" className="m-section-row" disabled={mode === 'offline'}
        onClick={mode === 'edit' ? onEdit : onDesktop}>
        <Icon name="pen" size={20} />
        <span className="m-section-name">Edit details</span>
        {mode === 'offline' ? (
          <span className="m-edit-note m-edit-note-locked">
            <span className="m-stale-dot" aria-hidden="true" />needs connection
          </span>
        ) : (
          <>
            <span className="m-edit-note">{mode === 'edit' ? 'date · time · guests' : 'desktop view'}</span>
            <span className="m-section-caret" aria-hidden="true"><Icon name="right" size={16} /></span>
          </>
        )}
      </button>
    </section>
  );
}

// The Note row: the internal booking note (proposals.admin_notes), on every
// event, cancelled included. It shows the note's first line.
export function NoteRow({ note, offline, onOpen }) {
  const line = noteFirstLine(note);
  return (
    <section className="m-section">
      <button type="button" className="m-section-row" disabled={offline} onClick={onOpen}>
        <Icon name="clipboard" size={20} />
        <span className="m-section-name m-note-name">Note</span>
        {offline ? (
          <span className="m-edit-note m-edit-note-locked">
            <span className="m-stale-dot" aria-hidden="true" />needs connection
          </span>
        ) : (
          <>
            <span className="m-note-preview">{line || 'Add a note'}</span>
            <span className="m-section-caret" aria-hidden="true"><Icon name="right" size={16} /></span>
          </>
        )}
      </button>
    </section>
  );
}
```

- [ ] **Step 4: Wire EventDetailPhone.js**

In `client/src/pages/mobile/EventDetailPhone.js`:

1. Imports: add
```js
import api from '../../utils/api';
import EditSheet from '../../components/mobile/EditSheet';
import NoteSheet from '../../components/mobile/NoteSheet';
import { ctDay } from '../../components/adminos/format';
import { editableEvent } from '../../utils/editSheetView';
```
and change the sections import to `import { Caret, ContactsSection, MoneySection, EditRow, NoteRow } from './EventDetailSections';`.
2. Replace `const SHEETS = ['shift'];` with `const SHEETS = ['shift', 'edit', 'note'];` and add under it:
```js
const SAVED_BEHIND = 'Saved. The event below could not be refreshed and may be out of date.';
```
3. Update the file's header comment: replace the sentence "The Edit details row opens that Desktop view until the edit sheet (lane ma-e3) lands." with "The Edit details row opens the edit sheet on an upcoming, live event and the Desktop view on a past one; the Note row edits the internal booking note on every event (lane ma-e3)."
4. Add state beside the others:
```js
  const [noteDraft, setNoteDraft] = useState(null);
  const [refresh, setRefresh] = useState('idle'); // idle | reading | behind
  const editLatch = useRef(false);
```
5. After `reloadShifts`, add the fresh re-read after an edit save:
```js
  // After an edit save: the event, the invoices and the roster moved. Never
  // the phone's stored copy, which is the event from BEFORE the save.
  const reloadAfterSave = useCallback(() => {
    setRefresh('reading');
    readShifts(false);
    if (refreshBadges) refreshBadges();
    Promise.all([api.get(`/proposals/${id}`), api.get(`/invoices/proposal/${id}`)])
      .then(([p, inv]) => {
        if (showing.current !== id) return;
        setProposal(p.data);
        setMoney({ state: 'ready', payload: inv.data });
        setStale((prev) => ({ ...prev, proposal: null, money: null }));
        setRefresh('idle');
      })
      .catch(() => { if (showing.current === id) setRefresh('behind'); });
  }, [id, readShifts, refreshBadges]);
```
6. After the existing `assignable` computation, add the edit and note sheet rules:
```js
  // The edit and note sheets. A parameter that can open neither here (another
  // event's id, a past event, a stored copy) is dropped once the event has
  // loaded. An edit sheet already open stays open if the roster loads behind
  // it and reads the event as finished: it is the person's work in progress.
  const todayYmd = ctDay(new Date());
  const editable = !!proposal && !cancelled && editableEvent(proposal, shifts, todayYmd);
  const editMode = staleAt ? 'offline' : (editable ? 'edit' : 'desktop');
  const forThis = drawer.id !== null && String(drawer.id) === String(id);
  const editOpen = drawer.kind === 'edit' && forThis && !staleAt && (editable || editLatch.current);
  editLatch.current = editOpen;
  const noteOpen = drawer.kind === 'note' && forThis && !staleAt;
  useEffect(() => {
    if (!proposal) return;
    if ((drawer.kind === 'edit' && !editOpen) || (drawer.kind === 'note' && !noteOpen)) closeDrawer();
  }, [proposal, drawer.kind, editOpen, noteOpen, closeDrawer]);
```
7. Directly after the staleness-line block (`{cachedTime && (...)}`), add:
```js
      {refresh === 'behind' && (
        <div className="m-fail" role="alert">
          <span className="m-fail-msg">{SAVED_BEHIND}</span>
          <button type="button" className="m-fail-retry" onClick={reloadAfterSave}>Retry</button>
        </div>
      )}
```
8. Replace the whole Edit details block (`{!cancelled && ( <section className="m-section"> ... </section> )}`) with:
```js
      <NoteRow note={proposal.admin_notes} offline={!!staleAt} onOpen={() => drawer.open('note', proposal.id)} />

      {!cancelled && (
        <EditRow mode={editMode} onEdit={() => drawer.open('edit', proposal.id)}
          onDesktop={() => setDesktopView('event-detail', true)} />
      )}
```
9. After the AssignmentSheet mount, add:
```js
      {editOpen && (
        <EditSheet
          proposalId={proposal.id}
          clientName={proposal.client_name}
          kind={headerOf(proposal).kind}
          shiftCount={shifts.state === 'ready' ? shifts.rows.length : 0}
          onClose={drawer.close}
          onSaved={() => { drawer.close(); reloadAfterSave(); }}
        />
      )}
      {noteOpen && (
        <NoteSheet
          proposalId={proposal.id}
          draft={noteDraft}
          onDraft={setNoteDraft}
          onSaved={(note) => setProposal((p) => (p ? { ...p, admin_notes: note } : p))}
          onClose={drawer.close}
        />
      )}
```
10. The existing sheet effect drops a `shift` param that names no shift of this event; make sure it acts only for `drawer.kind === 'shift'` (it does: `wanted` is null for other kinds). Leave it as is.

- [ ] **Step 5: Run the detail suite and every phone suite**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/mobile src/components/mobile src/utils/mobileClassContract.test.js src/pages/admin/EventDetailPage.fork.test.js`
Expected: PASS. (`EventsListPhone.test.js` "scroll offsets are saved only after the loaded list has been restored" is a known intermittent: if it alone fails in a multi-suite run, re-run that file alone before treating it as a regression.)

- [ ] **Step 6: CI build and commit**

Run: `cd client && CI=true npx react-scripts build`
Expected: exit 0. `wc -l client/src/pages/mobile/EventDetailPhone.js` is under 450.

```bash
git add client/src/pages/mobile/EventDetailSections.js client/src/pages/mobile/EventDetailPhone.js client/src/pages/mobile/EventDetailPhone.test.js
git commit -m "feat(phone): Edit details opens the edit sheet on an upcoming event; the Note row; a fresh re-read after a save"
```

### Task 7: Phone-viewport gate (orchestrator)

**Files:** none committed. Scratch scripts and screenshots live in the session scratchpad; the results go into "Browser checks" at the end of this plan, on main.

- [ ] **Step 1: Servers and the fixture**

Start the backend and client FROM THE LANE (the dev box sends no notifications: `server/utils/notificationsEnabled.js`; this path makes no Stripe call). Create a fixture on the dev database with a node script using the lane's `.env` and `require('./server/db').pool`, recording every id:
```sql
-- an active, non-hosted package, so the 25-guest rule never fires by accident
SELECT id FROM service_packages WHERE is_active AND pricing_type <> 'per_guest' ORDER BY sort_order LIMIT 1;
INSERT INTO clients (name, email, phone) VALUES ('Gate Edit <nonce>', 'gate-edit-<nonce>@example.com', '+15555550111') RETURNING id;
INSERT INTO proposals (client_id, status, event_date, event_start_time, event_duration_hours, guest_count, package_id,
  num_bars, total_price, amount_paid, event_type, venue_name, venue_street, venue_city, venue_state, venue_zip, event_timezone)
VALUES (<client>, 'deposit_paid', CURRENT_DATE + 30, '7:00 PM', 4, 100, <package>, 0, 350, 100, 'birthday-party',
  'Gate Hall', '1 Gate St', 'Rockford', 'Illinois', '61101', 'America/Chicago') RETURNING id;
INSERT INTO shifts (proposal_id, event_date, start_time, end_time, status, location, positions_needed)
VALUES (<proposal>, CURRENT_DATE + 30, '7:00 PM', '11:00 PM', 'open', 'Gate Hall', '["Bartender"]') RETURNING id;
```
Cleanup, by recorded id, in this order: `admin_audit_log` and `proposal_activity_log` rows for the proposal, `scheduled_messages` for it, `invoices` for it, the shift, the proposal, the client.

- [ ] **Step 2: The checks**

Playwright with the bundled Chromium at 390x844 (and 320x640 for overflow), dev JWT `jwt.sign({ userId: 1, tokenVersion: 0 }, JWT_SECRET)`, the recipe in `reference-mobile-local-review.md`. Record each as PASS or FAIL with its screenshot:
- E1: the fixture's detail shows Edit details with "date · time · guests"; tapping opens the sheet with "SAT ... " date, Start 19:00, "4 hr", Setup "<N> min before" with no arrow, Guests 100. Both skins.
- E2: Longer twice reads "5 hr"; More guests reads 105; the New total line, the balance line and the reprice lines appear; the PATCH request body (network capture) carries `addon_ids`, `addon_quantities`, `event_start_time: "7:00 PM"`, no venue key, no `gratuity_mandate_total`, and `notify: []`; the database row then holds 5 hours and 105 guests; the sheet closed and the detail shows the new figures.
- E3: a date change opens "Notify the client?" with Email and Text ticked, "Don't send" rightmost and primary; "Don't send" saves; the PATCH body has `notify: []` and the three staff flags false; the shift moved with the event.
- E4: open the sheet, change the row in the database (`UPDATE proposals SET guest_count = guest_count WHERE id = <proposal>` moves `updated_at`), tap Confirm: "This event changed since you opened it."; no PATCH in the capture; Reload shows fresh values.
- E5: start 23:30 with 4 hours: the curfew confirm with the server's reason; "Book it anyway" saves; the second PATCH carries `acknowledge_past_curfew: true`.
- E6: airplane mode (the service worker serving a stored detail): both rows read "needs connection" and open nothing.
- E7: Note row: "Add a note"; type a line, Save; the row shows it; reopen, type, press the browser Back: reopening shows the kept draft; Cancel clears it.
- E8: a past event (set the fixture's date to yesterday and its shift `status='open'`, past end): the row reads "desktop view".
- E9: Android-style Back (`page.goBack()`) with the edit sheet open closes it and stays on the detail.
- E10: at 320 wide nothing overflows horizontally; every new button and row is at least 44px tall (`getBoundingClientRect`); `elementFromPoint` at the centre of Confirm hits Confirm.
- E11: the benchmark comparison: the edit sheet next to the benchmark's edit sheet at the same width, both skins; every difference is one of the Decisions or a finding.

- [ ] **Step 3: Record**

Write the table into "Browser checks" at the end of this plan, on main. A FAIL goes back to the task that owns it.

### Task 8: Docs and ledgers

**Files:**
- Modify: `README.md`, `ARCHITECTURE.md`, `scripts/sensitive-paths.txt`, `docs/walkthroughs-owed.md`, `docs/fix-list-remaining-2026-07-02.md`

- [ ] **Step 1: README folder tree**

Add one line each, in their folders: `client/src/pages/admin/proposalEditor/editorCore.js # shared editor pieces: override detection, preview body, stored gratuity (desktop editor + phone edit sheet)`; `client/src/components/comms/notifyDrafts.js # notify-client drafts, payload and outcome toasts (desktop popup + phone notify step)`; `client/src/utils/editSheetView.js # pure view-model for the phone edit sheet`; `client/src/components/mobile/useEditSheet.js # the phone edit sheet's reads and writes`; `client/src/components/mobile/EditSheet.js # phone edit sheet: date, start, duration, guests, notify step`; `client/src/components/mobile/NoteSheet.js # phone note sheet: the internal booking note`.

- [ ] **Step 2: ARCHITECTURE**

In the "Phone event detail" passage: replace "on a cache-served read the Edit details row reads "needs connection" and does nothing, and otherwise it opens the Desktop view of this screen until the lane ma-e3 edit sheet lands" with a description of the two rows and the edit sheet (fresh reads, the desktop payload without the venue keys, the shared preview and reprice lines, the notify step, the re-read on `updated_at` before every PATCH, the curfew acknowledgement, the fresh re-read after a save) and the note sheet (`PATCH /proposals/:id/notes`, the kept draft, the changed-meanwhile choice). Add an "Edit sheet" bullet in the same style as the "Assignment sheet" bullet. Name `editorCore.js` and `notifyDrafts.js` where the editor and the notify popup are described.

- [ ] **Step 3: Sensitive paths**

Add to `scripts/sensitive-paths.txt`, with a comment line "Phone edit sheet (lane ma-e3): the money write surface and the shared payload, preview and notice builders":
```
client/src/components/mobile/useEditSheet.js
client/src/pages/admin/proposalEditor/patchBody.js
client/src/pages/admin/proposalEditor/editorCore.js
client/src/components/comms/notifyDrafts.js
```

- [ ] **Step 4: Walkthroughs owed**

Add a Tier 3b entry for the Pixel walk, gated on the squash being on origin: E1 to E9 of Task 7 on a real booking Dallas chooses, with one real date change sent through "Don't send" and one hours change on a paid event to see the gratuity line (and the client's automatic email, which is real in prod).

- [ ] **Step 5: Fix list and spec additions (orchestrator, on main)**

Mark the Admin UI entry "Edit details is a STICKY switch" as superseded for upcoming events (the edit sheet opens instead; past events still pin Desktop view). Add the plan decisions marked "plan" in the header (5, 6, 12, 15 placement, 16 head copy and disabled Save, 7 and 14 copy) to the spec's 2026-10-05 list. Add a line under the desktop twin of the stale-edit gap ("An editor tab left open across an on-site settle writes the old hours back"): the phone is closed by this lane's `updated_at` check; the desktop still is not.

- [ ] **Step 6: Commit (lane files only)**

```bash
git add README.md ARCHITECTURE.md scripts/sensitive-paths.txt docs/walkthroughs-owed.md docs/fix-list-remaining-2026-07-02.md
git commit -m "docs(phone): the edit sheet and note sheet in README and ARCHITECTURE; sensitive paths; the owed walk"
```

### Task 9: Lane close

- [ ] **Step 1: Suites reached and the build**

Run: `cd client && CI=true npx react-scripts test --watchAll=false` (the whole client suite; read the pass count).
Run: `cd client && CI=true npx react-scripts build` (exit 0).
No server suite: the lane changes no server file.

- [ ] **Step 2: The fleet**

`code-review`, `security-review`, `consistency-check`, `performance-review`, `ui-ux-review` (against the benchmark's Edit details row and edit sheet, the Decisions as the contract, both skins, 390 and 320), each on `git diff <lane base>..HEAD`, with a coverage manifest (every changed file in exactly one seat's package for the per-file verdict, plus the cross-cutting seats on everything). Iron rule: a seat that does not complete or returns no verdict is not a pass.

- [ ] **Step 3: Fold and merge**

Fix rounds re-reviewed by the seats that own the changed files. Record the as-built deltas at the end of this plan, on main. Merge with `scripts/merge-lane.sh ma-e3-edit-sheet docs/superpowers/plans/2026-10-05-mobile-admin-edit-sheet.md ma-e3-edit-sheet`, re-run the client suite on main, confirm every lane file is byte-identical on main, clean up the lane, write the board line. At push: the sensitive-path re-review and `/second-opinion` on this lane's commits.

## Self-Review (2026-10-05)

1. **Spec coverage.** Section 3, 2026-10-05: scope (event variant) Tasks 3 and 6; which events Tasks 2 (`editableEvent`) and 6 (`EditRow` modes); steppers and pickers Tasks 2 and 3; Setup read-only Task 3; the note Tasks 5 and 6; saving (fresh reads, desktop payload, no venue, no mandate, no contact) Tasks 1 and 3; the preview and the disabled Confirm Task 3; the confirm lines and the shared gratuity line Tasks 1 and 2; the button labels Task 2; changed since open Task 3 (and at the notify send, Task 4); the notify step Task 4; refusals and Saving Task 3; after a save Tasks 3 and 6; the extension hint and multi-shift note Tasks 2 and 3; the head and Back behaviour Tasks 3 and 5; no server change throughout. Section 4 structured edits Task 3; section 7 (no stored copy for a money sheet, writes never queue) Tasks 3, 5, 6; section 10 (inline failures) Tasks 3 to 6; section 11 (gate) Task 7. No gap found.
2. **Placeholders.** None: every code step carries its code, and Task 6 Step 1 names the one existing test it deletes and the three it keeps.
3. **Type consistency.** `useEditSheet` returns exactly the names Task 3's interface lists and Tasks 3 and 4 use (`pending`, `drafts`, `staff`, `setStaff`, `canSend`, `toggleChannel`, `sendUpdate`, `dontSend`, `backToEdit`, `acknowledgeCurfew`, `declineCurfew`, `reload`, `retryPreview`). `confirmView` returns `{ repriced, oldTotal, newTotal, balanceLine, lines, button }` (Task 2) as Task 3 draws it. `buildRepriceSummary`'s new keys are the same three in Tasks 1, 2 and the desktop rewire. `staffNotifyFlags` is defined in Task 1 and used in Task 3. `EditRow` modes `'edit' | 'desktop' | 'offline'` match Task 6's `editMode`.
4. **Review Focus.** The five lines each name their test; the lower list names its tasks.
5. **Known, accepted edges.** A proposal with a `total_price_override` keeps its total while its gratuity may still rise, so the gratuity email can go out with no reprice line (the summary only speaks on a reprice); prod has none upcoming, and the desktop shares it. A row write that changes nothing the sheet shows (a client opening their proposal page stamps `updated_at`) still reads as "changed since you opened it"; Reload costs one tap and is the safe direction. A start time stored in an unparseable shape shows blank and is sent as stored unless changed.
