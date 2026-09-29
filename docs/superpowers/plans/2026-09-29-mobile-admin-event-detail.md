# Mobile Admin Event Detail and Assignment Sheet (lane ma-e2-event-detail) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the phone, `/events/:id` stops rendering the desktop event page inside the phone chrome and renders the phone event detail from the 2026-09-15 benchmark (rich header with the venue map link, setup line, Contacts, Staffing, Financials, Edit details row), and every shift, booked or manual, is staffed from a phone bottom sheet (approve, deny, remove, assign) where Android Back closes the sheet and never leaves the page.

**Architecture:** Existing reads gain additive fields so the phone can show what the design draws without a new endpoint: `GET /shifts/by-proposal/:id` and `GET /shifts/detail/:id` carry `events_worked`, `finished` and (by-proposal) `requested_positions`; `GET /admin/active-staff` gains an opt-in `?shift_id=` that adds `events_worked` and a whole-mile `home_distance_miles` per row while the call without it stays byte-identical; `GET /drink-plans/by-proposal/:id` gains a `?fields=day_of_contact` projection. The admin service worker stores and stale-serves a read only for a request that asks (`offlineGet`), so the phone screens that render a staleness line get an offline copy and no desktop screen ever does. One new server util owns the events-worked count and is pinned to the seniority route by test. On the client, two pure modules carry all the logic (`staffingSheet.js` decides roster rows, open roles and the role step; `eventDetailView.js` derives header, contacts and financial rows), `AssignmentSheet` and `EventDetailPhone` render them with new `.m-sheet` and `.m-section` CSS folded from the design system and the benchmark, `useDrawerParam` gains a push-history option, and `EventDetailPage` forks at the top through `useMobileView()` exactly as `EventsDashboard` does. Every write goes through the endpoints the desktop drawer already uses; the phone adds no write path.

**Tech Stack:** Express + pg (`pool.query`), Node 26 `node --test` with the repo's hand-rolled `node:http` harness, React 18 + react-router 6.30 (`useSearchParams`, `useOutletContext`), jest + RTL 13 (jest-dom imported per file), a `vm`-loaded service worker for the allowlist test, `playwright-core` with the bundled Chromium for the phone-viewport gate, `scripts/mobile-capture.js` (`npm run mobile:check`).

**Spec:** `docs/superpowers/specs/2026-08-13-mobile-admin-design.md`: section 3 (fork, push-history sheets, Visual contract, the design-session decisions of 2026-09-15 and the plan decisions of 2026-09-29), section 4 Detail, section 7 Offline (staleness line, allowlist, writes never queue), section 9 (dead-route fallback), section 10 (inline failures with retry), section 11 (per-screen gate).

**Benchmark (Visual contract):** `docs/design-artifacts/2026-09-15-mobile-admin-shell.dc.html`, Event detail (`data-screen-label="Event detail"`, markup `:36-52` header and `:268-408` body, logic `:1229-1284`) and Assignment sheet (`data-screen-label="Assignment sheet"`, markup `:601-705`, logic `:1292-1373`, roster derivation `:981-1039`). Byte-compared against the live design project on 2026-09-28 (DesignSync `get_file`, project `8d8da3a4-97b1-4aa4-8999-0fec9f2a5f99`, `Phone Admin Shell.dc.html`): 140276 bytes both sides, identical, so the visual contract stands as written. It renders locally: `cd docs/design-artifacts && python3 -m http.server 8765`, then a headless Chromium at 460x960 on `http://127.0.0.1:8765/2026-09-15-mobile-admin-shell.dc.html` (the runtime loads React from unpkg, so the box needs network). States to compare against: detail with Staffing open (the default), Contacts open with a day-of contact and without one, Financials open with a balance and paid in full, a two-shift event (per-shift heads), the Edit details row unlocked and "needs connection"; sheet with one open role, with two open roles ("Approve as" and "Assign as" rows), a focused applicant, a focused rostered row, the Remove and Deny confirms, the failed save with Retry, the offline banner, the search field with no match, a manual shift (venue line in the head), a past event and a cancelled event (read-only). Both skins.

**Scope:** Lane ma-e2-event-detail only, as declared in `docs/superpowers/plans/2026-09-15-mobile-admin-events-list.md` (Lane map). The edit sheet is lane ma-e3: here the Edit details row opens the Desktop view of this screen. Not on the phone in phase 1 and reachable through the Desktop-view escape: the activity feed, invite to portal, re-enroll nudges, cancel event, cancel line, the Out-of-Area Bonus knob, equipment and supply-run edits, over-filling a role, editing a past or cancelled roster.

**Proven context (verified against the repo 2026-09-28 and 2026-09-29, not from memory):**
- `server/routes/shifts.js` (722 lines): `requireStaffing` `:51-55` (admin, or manager with `can_staff`); `withOutOfAreaContext` `:71-95`; `withHomeDistance(row, shift)` `:102-108` strips `staff_lat`/`staff_lng` and adds `home_distance_miles` via `roundMiles(milesBetween(...))` from `server/utils/serviceArea.js` (imported `:16-25`); `GET /by-proposal/:proposalId` `:333-386` selects `s.*`, `rc.request_count`, `rc.approved_count`, `approved_staff`, `requesters` (json objects with `request_id, user_id, name, status, position, dropped_at, staff_lat, staff_lng`, denied rows excluded) and `abr.approved_by_role`, with NO join to `proposals` and NO `requested_positions`; `GET /detail/:id` `:389-435` returns `{ shift, requests }` where `requests` is `sr.*` plus `staff_name, staff_email, staff_city, staff_reliable_transportation` and the derived distance, joined to `proposals p`; `DELETE /requests/:requestId` `:597-634` is a hard delete followed by `releaseOutOfAreaLock`, `reaccrueDutyForProposal` and BEO nudge suppression; `POST /:id/assign` `:682`; `PUT /requests/:requestId` `:701`. It imports `shiftNotFinishedSql` (`:12`) but not `shiftFinishedSql`.
- `server/routes/shifts.approval.js` (656 lines, sensitive-listed, NOT touched by this lane): `assignShiftHandler` `:250-432` 400s without a canonical `position` (`:254-255`), 404s an ineligible user (`:265-269`), upserts the request as approved clearing every drop marker, stamps the Out-of-Area lock, logs an over-fill to `proposal_activity_log` but ACCEPTS it, then sends the staffer an SMS and an email and may fire the client staffing confirmation. `approveOrDenyRequestHandler` `:440-648`: the `denied` branch (`:525-541`) updates the row and sends NOTHING; both notification blocks sit inside `if (status === 'approved')` (`:551`).
- `server/utils/shiftEndInstant.js` exports `shiftFinishedSql(s, p)` (`:219-221`); the proposal alias may be LEFT JOINed (the zone COALESCEs to America/Chicago).
- `server/routes/admin/users.js` (729 lines): `GET /active-staff` `:465-542`, guarded inline (admin, or manager with `can_staff`), `limit` capped at 100, ordered by `COALESCE(cp.display_name, cp.preferred_name, u.email)`, returning `{ staff, total, page, pages }`. A staff row has exactly these 20 keys: `cc_id, city, created_at, display_name, email, equipment_cooler, equipment_portable_bar, equipment_table_with_spandex, id, import_source, onboarding_completed, onboarding_status, phone, positions_interested, preferred_name, reliable_transportation, role, signed_at, state, travel_distance`. No seniority, no coordinates. `GET /users/:id/seniority` `:580-624` computes `events_worked` as live approved, not-dropped requests on shifts with `event_date < chicagoTodayYmd()` plus `contractor_profiles.historical_events_worked`; `server/utils/autoAssign.js:194-208` is its documented mirror.
- Client callers of `/admin/active-staff`: `AdminDashboard.js:49`, `StaffDashboard.js:77`, `staffHub/reviews/ReviewsPage.js:41`, `drawers/ShiftDrawer.js:142`. None passes `shift_id`.
- `server/routes/contractor.js:26-31` `sanitizeProfile` strips `seniority_adjustment`, `historical_events_worked` and `preferred_name_reviewed_at` from a contractor's OWN profile. It is not on any path this lane touches; the seniority GET already serves `events_worked` to admins and managers.
- `server/routes/proposals/getOne.js:21-129` `GET /proposals/:id` (`requireAdminOrManager`) returns `p.*` plus `client_name, client_email, client_phone, package_name`, `setup_time_display` (24h `HH:MM`, server-derived), the refund-side derived fields, `addons`, `activity`, `messageLog`. It carries NO payments list and NO in-flight payments.
- `server/routes/invoices.js:215-241` `GET /invoices/proposal/:proposalId` returns `{ invoices, pending_payments }`; invoice rows carry `label, amount_due, amount_paid, status, due_date, invoice_number` (cents) and no paid date; `pending_payments` rows carry `amount_cents, started_at, invoice_id, invoice_number` (the bank debit in flight, spec 2026-09-14). `invoices.js` is sensitive-listed and is NOT touched by this lane.
- `server/routes/drinkPlans.js:381-411` `GET /drink-plans/by-proposal/:proposalId` 404s when the proposal has no drink plan. The day-of contact is `selections.logistics.dayOfContact = { name, phone }`; there is no note or relationship field anywhere in the planner (`client/src/pages/plan/v2/PlannerV2.js:49`).
- **The admin service worker controls the desktop too** (established by the Task 2 review and Checkpoint A, 2026-09-29, and verified against the code). `registerAdminSw` (`client/src/utils/adminSw.js:7-14`, called from `AdminLayout.js:74`) registers it for any admin-host visitor; its API branch answers from the store on a transport failure or after a 4 second stall (`admin-sw.js:288-313` before this lane's edits); only `EventsListPhone.js` and `AuthContext.js` read `res.staleAt`. So every allowlisted read has been reaching desktop screens unlabelled since lane ma-b shipped (2026-08-14), `/api/proposals/:id` behind the desktop proposal page among them. Server CORS sets no `allowedHeaders` (`server/middleware/corsOptions.js`), so the `cors` package reflects the requested headers and a custom request header needs no server change.
- `client/public/admin-sw.js` (392 lines, sensitive-listed): `SW_VERSION = 'admin-sw-2026-08-14-v8'` (`:30`); `API_EXACT` `:182-193` holds `/api/shifts`, `/api/proposals`, `/api/admin/badge-counts`, `/api/admin/search`, `/api/admin/active-staff`, `/api/auth/me`; `isAllowlisted` `:194-197` adds `/^\/api\/proposals\/\d+$/` and the `/api/shifts/by-proposal/` prefix. `/api/shifts/detail/:id`, `/api/drink-plans/by-proposal/:id` and `/api/invoices/proposal/:id` are NOT allowlisted. The Cache API keys on the full URL, so `?shift_id=` makes each shift's candidate list its own entry. The file's top level only declares constants and functions and registers listeners on `self`, so it loads in a `vm` context with a stub `self`.
- `client/src/hooks/useDrawerParam.js` (49 lines): `{ kind, id, open, close }`, both writes `replace: true`, plus the named export `drawerHref`. No test file exists for it. Exactly three callers, `EventsDashboard.js`, `EventDetailPage.js` and `EventsListPhone.js`, all relying on replace semantics. The app's router is `<BrowserRouter>` (`App.js:689`), which keeps its position in `window.history.state.idx`.
- `client/src/utils/staffingRoles.js` (112 lines) exports `ROLES, CANONICAL_LABELS, canonicalizeRole, isBartender, parsePositionsNeeded, rosterCounts, computeRemaining, classifyRequest, isEventFullyStaffed, ASSIGN_ROLE_PREFERENCE, defaultAssignRole`. `classifyRequest(requested, remaining)` treats an EMPTY ranked list as "any open role". `client/src/components/adminos/shifts.js` exports `neededCount` (`:96`, an empty roster counts as 1), `parsePositionsCount` (`:115`), `isCancelledEvent` (`:66`).
- `client/src/components/adminos/drawers/ShiftDrawer.js` (803 lines) is the desktop reference: approvals go through `POST /shifts/:id/assign { user_id, position }` (`:261-264`), never through the PUT; deny is `PUT /shifts/requests/:id { status: 'denied' }` (`:278`); remove is `DELETE /shifts/requests/:id` behind a `window.confirm` (`:290-293`); approved means `status === 'approved' && !dropped_at` (`:161-164`). Reference only: this lane does not edit it.
- `client/src/pages/admin/EventDetailPage.js` (657 lines): `export default function EventDetailPage()` at `:38`; reads `GET /proposals/:id` and `GET /shifts/by-proposal/:id` together (`:120-123`) and `GET /drink-plans/by-proposal/:id` separately (`:144`); the payment panel reads `GET /invoices/proposal/:id` (`ProposalDetailPaymentPanel.js:98`) and computes `balanceDue = total_price - amount_paid` and "paid in full" as a paid status AND `balanceDue <= 0` (`:20-47`).
- `client/src/components/AdminLayout.js` (304 lines): `outletCtx = useMemo(() => ({ badges, refreshBadges: fetchBadges }), ...)` at `:139`; `screenKey = routeScreenKey(location.pathname)` `:179`; the `mobile-route-dead` listener `:217-223` navigates to `/events` with replace; the phone branch `:232-256` renders `<MobileHeader title screenKey onBack />` and the scroll host `<main className="m-main" id="main-content">`. `client/src/components/mobile/MobileHeader.js` (52 lines) has no detail variant and no test. `AdminLayout.js:228-229` sets `Sentry.setTag('surface', 'mobile-admin')` on the global scope while the phone chrome is mounted, so every phone component here already reports with the spec section 10 tag; no component tags itself. `client/src/utils/screenKey.js` already maps `/events/:id` to `event-detail`.
- `client/src/pages/mobile/EventsListPhone.js` (291 lines): imports the desktop `ShiftDrawer` (`:10`), uses `useDrawerParam()` with replace semantics (`:36`), opens manual shifts with `drawer.open('shift', id)` (`:143`), mounts the interim drawer only while open (`:233-243`). Its test stubs `ShiftDrawer` (`EventsListPhone.test.js:11`).
- `client/src/utils/eventCards.js` exports `eventKeyOf, railParts, placeOf, groupShiftRows`; `client/src/utils/staleTime.js` exports `formatStaleAt, formatStaleTime`; `client/src/utils/setupTime.js` exports `subtractMinutesFromTime, formatSetupTime`; `client/src/components/adminos/format.js` exports `fmt$2dp` (dollars), `fmt$fromCents` (cents), `fmtDate`, `fmtTime24`, `fmtTimeRange24`, `dayDiff`; `client/src/components/VenueAddressFields.js:100` exports `venueMapQuery`; `client/src/utils/gratuityLabels.js:10` exports `resolveGratuityDisplayLabel`; `client/src/utils/api.js` rejects with `{ message, code, fieldErrors, status }` (`status: 0`, `code: 'NETWORK_ERROR'` on a transport failure) and sets `res.staleAt` on a cache-served response.
- `client/src/index.css` (21449 lines): the mobile block runs `:20934-21375`; the Events list rules are `:21240-21375`; the Staff hub block's comment opens at `:21377`. `.m-more-list` and `.m-more-row` exist (`:21075-21103`). NO `.m-sheet*`, `.m-section*`, `.m-stepper*`, `.m-pill*` or `.m-dhead*` rule exists. `.staff-pill` does not exist anywhere in `client/src`. The lock is `z-index: 10000` (`:21185`), the return pill 39 (`:21110`). Icon names used here all exist in `client/src/components/adminos/Icon.js`: `left, right, external, users, userplus, dollar, pen, check, clock, x`.
- Design-system CSS to fold from: `docs/design-artifacts/_ds/dr-bartender-os-design-system-72035042-c993-47e2-9dc8-c452b7bf5fa4/components-mobile.css:158-214` (`.m-sheet-scrim`, `.m-sheet`, `.m-sheet-handle`, `.m-sheet-title`, `.m-sheet-row`, light-skin squaring `:322`) and `components-admin.css:326-331` (`.staff-pills`, `.staff-pill`, `.staff-count`).
- The client lints with `eslint-config-react-app`, which sets `no-throw-literal: warn`, and the client build runs with `CI=true`, where a warning is fatal. So a thrown object literal fails the build: throw `Error` instances. (`eslint.config.mjs:62` carries the same rule as an error, for `server/**` only.)
- `scripts/mobile-capture.js` resolves `:token` in a page path from `tokenQuery` (`:102-106`), fails a page only on horizontal overflow, and reports taps under 36px and text under 12px without failing.
- `scripts/sensitive-paths.txt` lists `client/public/admin-sw.js` (`:382`), `server/routes/shifts.approval.js` (`:77`) and `server/routes/invoices.js` (`:296`). It does not list `server/routes/shifts.js`, `server/routes/admin/users.js`, `client/src/hooks/useDrawerParam.js` or anything under `client/src/pages/mobile/`.
- Prod, read 2026-09-28 (Neon `round-tooth-34649976`, read-only): 16 active staff, 10 of them geocoded; 20 upcoming live shifts, 10 geocoded; 0 upcoming manual shifts; 0 upcoming multi-shift events; 0 upcoming shifts with an empty, object-shaped or mixed-role roster; 16 pending requests on upcoming shifts; 54 drink plans carry a day-of contact. So distance is absent for half of what Dallas will look at, and the per-shift grouping, the manual sheet and the "Approve as" rows are exercised today only by fixtures. Read 2026-09-29: of 83 approved, not-dropped requests all-time (9 on upcoming shifts), none has a NULL or non-canonical `position`; the column is nullable, so Task 4 still counts such a row as filling a slot.
- Design system, compared 2026-09-29 (DesignSync `get_file`, project `72035042-c993-47e2-9dc8-c452b7bf5fa4`): the rules this lane folds from match the vendored copies rule for rule, in `components-mobile.css` the bottom-sheet family and the light-skin squaring (which gives `.m-more-list` `border-color: var(--line-2)` and `box-shadow: none`), in `components-admin.css` the staffing pills. That was a comparison of those rules, not a byte compare of the two files; the byte compare covered the shell benchmark.
- Main carries two unpushed phone commits from another window, `9a73d5ba` and `a84555c3` (card place line, kind line, fraction and tag colours). They changed `eventCards.js`, `EventsListPhone.js` and `index.css`; the line numbers above were read AFTER them.

**Decisions this plan makes (each is recorded in the spec: section 3 "Plan decisions of 2026-09-29", section 4 and section 7). The visible ones (1, 2, 8 to 19) are the complete list of intended departures from the benchmark: `ui-ux-review` treats them as the contract, and any other difference is a finding.**
1. **The Deny confirm tells the truth.** The benchmark copy reads "They are notified and the request is closed." The server notifies nobody on a deny. Phone copy: `Deny <name>'s application? The request closes. They are not notified.` Adding a notification is server work on a sensitive file and is not in this lane.
2. **Assign always shows the role step.** In the benchmark a candidate row with one open role assigns on a single tap. An assignment texts and emails a real person and writes the payroll seam, and a stray tap while scrolling a list is the likeliest phone mistake there is. So a candidate tap always opens the "Assign as" rows, one row when one role is open. An applicant's Approve with exactly one open role that the applicant ranked stays direct (it is already the second tap: row, then Approve). A waitlisted applicant, whose ranked roles are all full, always gets the "Approve as" rows, even for one open role, because that role is one they did not ask for.
3. **The phone never over-fills.** With no open role, Approve is disabled and the Assign section is absent. Over-filling is a deliberate desktop action. Because the server accepts an over-fill, the sheet re-reads the shift immediately before an approve or an assign and refuses when the chosen role is no longer open.
4. **A cache-served roster is read-only.** Role resolution depends on a live roster, so when the sheet's read was served by the service worker every action is disabled and the offline banner shows, with a Retry.
5. **Past and cancelled rosters are read-only on the phone** (the benchmark draws it). Removing a no-show after the event is a payroll correction and stays on the desktop. This needs the server to say whether a shift finished, by its end instant.
6. **Seniority and distance ride additive fields** on the three existing reads. No new endpoint (spec section 2's endpoint rule); the spec names the extensions.
7. **Two reads and one projection join the service worker allowlist** (amended by Checkpoint A, see Decisions 20 and 21): `/api/shifts/detail/:id`, `/api/invoices/proposal/:id`, and `/api/drink-plans/by-proposal/:id` only as `?fields=day_of_contact`. The invoices read is cached on purpose: it carries the bank debit in flight, and an offline detail that shows a plain balance while a debit is settling is the proposal 784 mistake waiting to happen again. The by-proposal entry, a prefix match since ma-b, is anchored.
8. **Financials reads what the desktop panel reads.** Lines from `pricing_snapshot.breakdown`, total and paid from the proposal row, payments from the invoices read (label, state, amount, no paid date because none is stored on the invoice), the bank debit in flight as its own row and a "Processing" chip. The benchmark's "Updated total" label becomes "Total": nothing here is an update.
9. **The day-of contact has no note.** The benchmark draws "Marcus Keller · the client"; the planner stores a name and a phone only.
10. **Edit details opens the Desktop view of this screen** until lane ma-e3 lands, with the trailing label "desktop view"; on a cache-served read it reads "needs connection" and does nothing.
11. **A shift with no declared roles** (none upcoming in prod) is read-only for approve and assign with the note "No roles are declared on this shift. Staff it from desktop view." The note shows in the sheet and, in place of the "Assign staff" row, on the detail's staffing card.
12. **Contacts are tap targets.** The benchmark draws the client's phone and email as plain 12px and 11px text. Spec section 4 makes the phone tap-to-call and tap-to-text, and a tap target is 44px. So each number and address is a 44px row in the link colour, and each phone carries a bordered "Text" button.
13. **Money shows cents, and a negative shows a true minus sign.** The benchmark draws whole dollars. Real totals carry cents and the desktop panel shows them; the phone must never round a balance.
14. **The when line carries the duration and, outside the current year, the year** ("SAT AUG 15 · 18:00–23:00 · 5h"), on the detail and in the sheet head. The list card already does; the rail has no year, and an event next January otherwise reads as this one. Dates in the money rows are uppercase like the rail ("due AUG 8").
15. **A per-shift head leads with the start time, and with the date when the event spans more than one day** ("16:00 · Bartenders"). The benchmark labels a shift by its roles alone, which cannot tell apart the two Bartender shifts of a two-day event.
16. **A cancelled event says so.** A "Cancelled" chip on the when line (in place of "Today") and on Financials, no fraction in the Staffing head, and no Edit details row: there is nothing to edit on a cancelled event from the phone. Where nothing is owed but the status is not a paid one, the Financials chip reads "No balance" rather than claim "Paid". The benchmark draws neither case.
17. **The offline banner and a picker that failed to load each carry a Retry.** A cache-served roster is often a slow connection, not a lost one, and without a Retry the only way to try again is to close the sheet.
18. **Rostered rows are alphabetical,** as the desktop card's are. The benchmark keeps fixture order.
19. **Distances are whole miles** ("7 mi", where the benchmark draws "6.8 mi"). The picker returns a distance for every active staffer against any shift, and the phone stores what it reads: at a tenth of a mile, ten venues place a home within about two hundred feet. The server rounds the picker's distances to the mile; the phone rounds every distance it shows, so applicants and candidates read alike. (Checkpoint A, M2.)
20. **Cached reads are opt-in, per request.** The service worker stores a response, and answers from the store, only for a request that carries `X-Offline-Ok: 1`, which `offlineGet` sends. A caller may send it only if it renders the staleness line and takes no action on a cache-served copy. `/api/auth/me` keeps today's behaviour, so the sensitive `AuthContext` is untouched. This changes shipped behaviour on purpose: desktop screens stop being served stored copies of `/api/proposals/:id` and the other allowlisted reads, and the desktop pages that still render inside the phone chrome (proposals, until ma-f1 and ma-f2) lose their unlabelled offline copy. The phone Events list keeps its offline mode by switching to `offlineGet` (Task 9). (Task 2 review; Checkpoint A, L5.)
21. **The phone never reads the full drink plan.** It reads `?fields=day_of_contact`, a name and a phone, and that projection is the only form of the read the service worker stores. The full plan carries its write-capable token, the internal notes, and the venue access notes clients are asked to type gate codes into. (Checkpoint A, M1, the one finding that failed the checkpoint.)
22. **A malformed id is a dead route, not an error.** `/events/abc` dispatches `mobile-route-dead` without fetching; the two shifts reads answer 400 instead of raising in Postgres. An error screen whose Retry can never succeed is a dead end.

**Accepted for this lane, on the fix list (Checkpoint A, L2 to L4):** the reads the phone stores still carry public tokens the phone never uses, and those tokens cannot be reissued; nothing in the cache ages out; a permission downgrade purges only the URL that answers 403. The security review judged these more of a class the spec already accepted. What protects the stored bytes is the phone's own lock: if the phone is lost, erase it first and revoke second.

## Global Constraints

- **No em dashes** in copy, comments, commit messages or docs. Commas, colons, parentheses, the middle dot. A missing value renders as nothing, never as a dash glyph.
- **One fork, one breakpoint:** the phone branch comes from `useMobileView()` only. No new width media queries; every new rule lives in the mobile block of `index.css`, scoped `html[data-app="admin-os"]`, both skins.
- **Unique `m-*` class names for everything this lane ADDS, modifiers included.** `.m-tag.bar` collided with the design system's `.bar` rule in ma-e1. Write `m-act-danger`, never `m-act danger`. Two things that already exist are reused as they are: the primitives `chip` and `chip-dot` through `StatusChip`, and the ma-e1 fraction with its states, `m-frac`, `m-frac full` and `m-frac past`.
- **Rows inside a detail section are `m-section-item`; rows inside the sheet are `m-sheet-row`.** Same declarations, two names: spec section 3 forbids shipping the sheet's row class inside a detail screen.
- **`position` is the payroll seam.** Every approve and assign sends an explicit canonical `position` that was visible on screen before the tap. Never defaulted, never inferred, never sent as anything `canonicalizeRole` would reject. The phone never calls `defaultAssignRole`.
- **Writes go through the desktop's endpoints, unchanged:** `POST /shifts/:id/assign { user_id, position }` for approve and assign, `PUT /shifts/requests/:id { status: 'denied' }`, `DELETE /shifts/requests/:id`. This lane edits no write handler and does not touch `server/routes/shifts.approval.js`.
- **One write at a time.** While a write is in flight every action button in the sheet is disabled, guarded by a ref so a double tap cannot fire two requests.
- **Writes never queue** (spec section 7). A failed save stays on screen, inline, under the row it came from, with Retry. Copy for a transport failure, verbatim: `No connection, didn't save.` A server refusal shows the server's message.
- **Legacy response shapes are frozen.** `GET /admin/active-staff` without `shift_id` returns the same 20 keys per row. The two shifts reads only gain fields.
- **Raw home coordinates never leave the server.** No response in this lane carries `lat`, `lng`, `staff_lat` or `staff_lng` for a person. The picker's distances leave as whole miles.
- **The phone never requests the full drink plan.** Only `?fields=day_of_contact`.
- **Only `offlineGet` may be answered from the phone's cache, and only a screen that renders the staleness line may call it.** `offlineGet` is `api.get` plus the header `X-Offline-Ok: 1` (`client/src/utils/offlineRead.js`). Every read a write depends on (the sheet's re-read before an approve or an assign) and every desktop read uses plain `api.get`, which the service worker never stores and never answers.
- **Staleness line, two states,** on the detail: live = `as of <fetch time>` with no dot; cache-served = `offline copy · as of <cached time>` with the amber dot. Only the time sits inside `.m-stale-time`.
- **Sticky rows** inside the scroll host `main#main-content` use `top: -0.75rem` (the host's own padding), never `top: 0`.
- **44px minimum tap targets** for every button and link this lane adds.
- **Copy from the benchmark, verbatim, except where the decisions above replace it:** "Contacts", "Client", "Day-of contact", "day-of set", "day-of pending", "Not received yet. Collected with the drink plan; often the client themselves.", "Staffing", "Assign staff · N open", "Pending", "Waitlisted", "Financials", "Package & extras", "Payments", "Balance due", "due <date>", "due date not set", "Paid in full", "Paid", "Edit details", "needs connection", "On this shift", "Approve", "Deny", "Remove from shift", "Keep", "Remove", "Approve as", "Assign as", "N open", "Assign", "Search active staff", "Retry", "just assigned", "No connection. Staffing actions need the server; the roster below is the cached copy.", "Past event · roster is read-only", "Cancelled · roster is read-only", the Remove confirm `Remove <name> from this shift? Payroll re-accrues and any out-of-area lock is released.`, "Offline", "Today", "GUESTS", the setup line `setup from <HH:MM> · <N> min before`, the picker head `Assign · <role> × <N>`, the no-match line `No active staff matches “<query>”.` (curly quotes, as drawn), and the Deny confirm with the typographic apostrophe the benchmark uses.
- **Added copy, with no benchmark source, held here so a reviewer can check it:** "Text", "No phone or email on file.", "The day-of contact needs a connection.", "Loading the day-of contact", "Loading the roster", "Loading the event", "Loading the payment detail", "Staffing needs staffing access.", "Couldn't load staffing.", "Couldn't load this event", "No shifts created for this event yet." (the desktop card's line), "Total", "Paid to date", "Payment detail needs a connection.", "No payments yet.", "Bank payment processing", "started <DATE>", "part paid · <$> of <$>", "paid", "bank payment in flight", "Processing", "No balance", "Cancelled", "desktop view", "Everyone active is already on this shift.", "Couldn't load the staff list.", "The roster changed. Check the open roles and try again.", "Something went wrong. Try again.", "Network error. Check your connection." (the api client's own), "No roles are declared on this shift. Staff it from desktop view.", and the Deny confirm `Deny <name>’s application? The request closes. They are not notified.`
- **Server tests:** `node --test <file>` one suite at a time from the repo root; `require('dotenv').config()` on the first line; `process.env.SEND_NOTIFICATIONS = 'false'` before any require; `NODE_ENV !== 'production'` guard; nonce'd fixtures deleted BY RECORDED ID in `after`. Read the pass count, not only the fail count.
- **Client tests:** no `setupTests.js` exists, so `import '@testing-library/jest-dom'` in every test file; a `jest.mock` factory may close over `mock`-prefixed names only; CRA runs `resetMocks: true`, so set mock return values inside each test or a `beforeEach`; a ToastContext stub must be one stable object.
- **Client gate:** `cd client && CI=true npx react-scripts build` before any commit touching `client/`.
- **File-size ratchet:** `shifts.js` (722) and `users.js` (729) are in the yellow zone; the new SQL lives in a new util so each grows by under 20 lines. New files stay under 400 lines (the sheet lands at about 370, the page at about 280 with its presentational sections in their own file; CLAUDE.md calls 300 to 600 fine for a focused page or component).
- **Explicit staging only;** commit messages carry NO backticks; stage and commit in one command chain; never `npm install` inside the lane (it replaces the shared `node_modules` symlink).
- **Docs law:** README folder tree (new page, component, utils, server util), ARCHITECTURE route table (the three extended reads) and PWA section (allowlist), walkthroughs-owed (the Pixel walk), the fix-list entry.

## Review Focus

The five conditions the spec implies and that are most likely to bite Dallas on the phone, most likely first. Each has a named test in the task that owns the code.

1. **A double tap on Approve or an "Assign as" row on a slow connection.** Expected: one request, one text to the staffer. Pinned in Task 6 (`a second tap while a write is in flight sends nothing`).
2. **A person or a venue with no coordinates** (6 of 16 staff and 10 of 20 upcoming shifts in prod). Expected: the meta line shows what is known ("14 events") and never "null mi", "NaN mi" or a made-up "0 mi". Pinned in Task 4 (`staffMeta omits what is missing`) and Task 1 (`no coordinates on either side yields null`).
3. **The roster moved while the sheet was open** (another admin, or a staffer's own request, filled the last slot). Expected: the phone refuses rather than over-filling, says so, and shows the new roster. Pinned in Task 6 (`a role that filled since the sheet opened is refused before the write`).
4. **Android Back with a sheet that arrived by deep link or cold route restore,** so no history entry sits behind it. Expected: Back closes the sheet and stays on the page. Pinned in Task 3 (`a deep-linked sheet gets an entry seeded behind it`).
5. **A bank debit in flight on the event** (rare, five ACH charges since June, and the one that double-charged proposal 784). Expected: the Financials chip reads "Processing" and the balance row says a payment is in flight, including offline. Pinned in Task 7 (`a payment in flight wins the chip`) and Task 3b (the invoices read is cached for a request that asks).

Also pinned, lower on the list: a proposal with no pricing snapshot still renders a total (Task 7); a request with an empty or unparseable `requested_positions` renders "Any role" and classifies like the desktop (Task 4); a manager without `can_staff` gets the detail without staffing instead of being thrown back to the list (Task 8b); a drink-plan 404 is "no day-of contact", not an error (Task 8b); an approval with no role on file still fills its slot, so the phone never offers it again (Task 4); a failure box never outlives the action it belongs to (Task 6); a staffing reload that lands after the screen moved to another event is dropped (Task 8b); a desktop read is never stored and never answered from the store (Task 3b, and D12b in the gate); the full drink plan is never requested by the phone and never stored (Tasks 3b, 7, 8b, and D12c).

## Lane map

```yaml
lanes:
  - id: ma-e2-event-detail
    phase: 3
    scope: >
      Phone event detail at /events/:id per spec section 4 Detail and the
      2026-09-15 benchmark (rich header with the venue map link, setup line,
      Contacts with the drink-plan day-of contact, Staffing card grouped per
      shift when the event has more than one, Financials with the bank debit
      in flight, Edit details row that opens the Desktop view until ma-e3) and
      the assignment sheet (the phone ShiftDrawer for one shift: roster with
      inline Approve, Deny, Remove behind confirms, role rows, alphabetical
      active-staff picker with search, seniority and distance as plain meta,
      failure with Retry, offline and read-only states). Additive fields on
      three existing reads, a day-of-contact projection on the drink plan
      read, cached reads made opt-in per request in the admin service worker
      (which also takes them away from desktop screens), the push-history
      option on useDrawerParam. Replaces the ma-e1 interim drawer
      for manual shifts. Visual fidelity to the benchmark is owned here: the
      lane folds the design system's sheet CSS and promotes the benchmark's
      inline treatment to m-* classes.
    inputs:
      - docs/design-artifacts/2026-09-15-mobile-admin-shell.dc.html
      - docs/design-artifacts/_ds/dr-bartender-os-design-system-72035042-c993-47e2-9dc8-c452b7bf5fa4/components-mobile.css
      - docs/design-artifacts/_ds/dr-bartender-os-design-system-72035042-c993-47e2-9dc8-c452b7bf5fa4/components-admin.css
    footprint:
      - server/utils/staffingMeta.js
      - server/routes/shifts.js
      - server/routes/admin/users.js
      - server/routes/drinkPlans.js
      - server/routes/shifts.staffingMeta.test.js
      - server/routes/drinkPlans.dayOfContact.test.js
      - client/public/admin-sw.js
      - client/src/utils/adminSwAllowlist.test.js
      - client/src/utils/offlineRead.js
      - client/src/utils/offlineRead.test.js
      - client/src/hooks/useDrawerParam.js
      - client/src/hooks/useDrawerParam.test.js
      - client/src/utils/staffingSheet.js
      - client/src/utils/staffingSheet.test.js
      - client/src/utils/eventDetailView.js
      - client/src/utils/eventDetailView.test.js
      - client/src/utils/mobileDetailCss.test.js
      - client/src/utils/mobileClassContract.test.js
      - client/src/components/mobile/AssignmentSheet.js
      - client/src/components/mobile/AssignmentSheet.test.js
      - client/src/components/mobile/MobileHeader.js
      - client/src/components/mobile/MobileHeader.test.js
      - client/src/components/AdminLayout.js
      - client/src/pages/mobile/EventDetailPhone.js
      - client/src/pages/mobile/EventDetailSections.js
      - client/src/pages/mobile/EventDetailPhone.test.js
      - client/src/pages/mobile/EventsListPhone.js
      - client/src/pages/mobile/EventsListPhone.test.js
      - client/src/pages/admin/EventDetailPage.js
      - client/src/pages/admin/EventDetailPage.fork.test.js
      - client/src/index.css
      - scripts/mobile-capture.manifest.json
      - scripts/sensitive-paths.txt
      - README.md
      - ARCHITECTURE.md
      - docs/walkthroughs-owed.md
      - docs/fix-list-remaining-2026-07-02.md
    depends_on: []  # ma-e1-events-list is merged (d1dc829f) and live
    review_fleet: [code-review, consistency-check, security-review, database-review, performance-review, ui-ux-review, second-opinion]
    # A sensitive path (client/public/admin-sw.js) is in the footprint, so this is
    # the full fleet. security-review: position is the payroll seam, and two reads
    # start serving seniority and distance. database-review: new SQL.
    # performance-review: by-proposal and detail gain a second round trip,
    # active-staff with shift_id gains three queries, and each shift_id is its
    # own cache entry. ui-ux-review judges against the benchmark, Event detail
    # and Assignment sheet, with the plan's decisions as the contract.

  # Declared in the 2026-09-15 plan, unchanged, each with its own plan when its turn comes:
  # ma-e3-edit-sheet (depends on this lane), ma-f1-proposals-list, ma-f2-proposal-detail
  # (depends on this lane for the section and sheet CSS), ma-f3-search.
```

**Task order.** Tasks run in the order written, one implementer each: 1, 2, 3, 3b, 4, 5, 6, 7, 8a, 8b, 9, 10, 11, 12. Tasks 1 and 2 are the server and service worker contract; Task 3b is that contract as Checkpoint A amended it, and every later task consumes the AMENDED contract. Tasks 3 and 4 are pure and independent of each other; Task 7 is pure and imports `buildShiftView` from Task 4, so it cannot run before it. Task 5 (CSS) precedes the components that use it. Task 6 (sheet) precedes Task 8b (detail), which mounts it; Task 8a (header and layout) precedes 8b. Task 9 wires both in. Task 10 is the browser gate, Task 11 the docs, Task 12 the lane close.

**Who writes what.** An implementer sees this header and their own task, commits only the paths their task names, and REPORTS anything the plan should record. The plan and the spec live on main and are edited there by the orchestrator, never from the lane (the pre-commit guard blocks a plan or spec commit off main). So the Browser checks table, the as-built deltas and any footprint amendment are written by the orchestrator from the implementers' reports.

**Checkpoint A ran 2026-09-29: database-review PASS, security-review FAIL (narrowly, on one finding). Its outcome is Task 3b and Decisions 19 to 22; the record is in the Self-Review, item 7. The brief it ran on, kept for the record:** security-review and database-review on the contract, after Tasks 1 and 2. Run by the orchestrator on the diff of Tasks 1 and 2 (the ma-d lane's checkpoint caught a real leak at exactly this point). Brief for security-review: who can read `events_worked` and `home_distance_miles` (it must be exactly the `requireStaffing` set); whether any path returns a raw coordinate; whether `shift_id` lets someone who could not already list shifts probe for their existence; whether the three new allowlist patterns can match a public token route or any path outside the three named reads; and what the newly cached PAYLOADS carry at rest (`GET /invoices/proposal/:id` returns each invoice's public `token`; `GET /proposals/:id`, cached since ma-b, already carries the proposal's), with a verdict on whether that footprint is acceptable under spec section 7's per-user namespace and purge rules. Brief for database-review: the `loadEventsWorked` plan on the dev database (`EXPLAIN ANALYZE` with 16 ids), the added `LEFT JOIN proposals` on by-proposal, and that `finished` is computed per row without a second scan. Findings fold into Tasks 1 and 2. A finding that changes the CONTRACT (a field name, a shape, a status code) is folded by the orchestrator into the text of Tasks 4, 6, 7 and 8b on main before any of them is dispatched.

**A known flaky test, not this lane's.** `EventsListPhone.test.js`, "scroll offsets are saved only after the loaded list has been restored", fails intermittently when many suites run together and passes alone, with and without this lane's changes (seen in the plan fleet's scratch runs, 2026-09-29). If it fails in a multi-suite run, re-run that file alone before treating it as a regression.

---
### Task 1: Staffing meta on the three reads (events worked, distance, finished, ranked roles)

> **Built 2026-09-29 as `df5f8d28`, from the text below, review clean.** Checkpoint A then amended the contract: Task 3b makes the picker's distances whole miles, validates the path id on the two shifts reads, and strengthens this task's test. Where this section and Task 3b differ, Task 3b is what the lane holds.

**Files:**
- Create: `server/utils/staffingMeta.js`
- Modify: `server/routes/shifts.js` (imports `:12` and `:26`; `GET /by-proposal/:proposalId` `:333-386`; `GET /detail/:id` `:389-435`)
- Modify: `server/routes/admin/users.js` (imports `:1-18`; `GET /active-staff` `:465-542`)
- Test: `server/routes/shifts.staffingMeta.test.js`

**Interfaces:**
- Consumes: `milesBetween(latA, lngA, latB, lngB)` and `roundMiles(n)` from `server/utils/serviceArea.js`; `chicagoTodayYmd()` from `server/utils/businessTime.js`; `shiftFinishedSql('s', 'p')` from `server/utils/shiftEndInstant.js`.
- Produces, for Tasks 4, 6, 7 and 8:
  - `GET /shifts/detail/:id` -> `{ shift, requests }`; `shift` gains `finished: boolean` and `proposal_status: string | null`; every `requests[]` row gains `events_worked: number`.
  - `GET /shifts/by-proposal/:id` -> array; every shift gains `finished: boolean`; every `requesters[]` row gains `requested_positions` (the stored ranked list, a JSON string or array) and `events_worked: number`.
  - `GET /admin/active-staff?limit=100&shift_id=<id>` -> `{ staff, total, page, pages }`; every `staff[]` row gains `events_worked: number` and `home_distance_miles: number | null`. Without `shift_id` the row has exactly its 20 legacy keys. A `shift_id` that is not a positive integer within the int4 range is a 400; a `shift_id` that matches no shift is a 404.
  - `server/utils/staffingMeta.js` exports `loadEventsWorked(userIds, db?) -> Promise<Map<number, number>>` and `candidateMeta(shiftId, userIds, db?) -> Promise<Map<number, { events_worked, home_distance_miles }> | null>` (null when the shift does not exist).

- [ ] **Step 1: Write the failing test**

Create `server/routes/shifts.staffingMeta.test.js`:

```js
// Staffing meta on the three reads the phone staffing surfaces use (lane
// ma-e2, spec 2026-08-13-mobile-admin sections 3 and 4).
//
// Three kinds of claim, kept apart on purpose:
//   1. ADDITIVE. The two shifts reads gain events_worked, finished and (on
//      by-proposal) requested_positions. Nothing they returned before moves.
//   2. FROZEN. GET /admin/active-staff without shift_id returns exactly the
//      20 keys it returned before this lane. The desktop drawer, the roster and
//      the reviews page all read that shape.
//   3. ONE DEFINITION. events_worked here equals GET /admin/users/:id/seniority
//      for the same person, so this third reader cannot drift from the two
//      that feed auto-assign.
// And one privacy law: no response carries a person's raw home coordinates.

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { chicagoTodayYmd } = require('../utils/businessTime');

if (process.env.NODE_ENV === 'production') {
  throw new Error('shifts.staffingMeta.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = (label) => `staffing-meta-${NONCE}-${label}@example.com`;
// Sorts to the top of the alphabetical active-staff feed, so the fixtures are
// inside the first 100 rows however many staff the dev database holds.
const NAME = (label) => `AAA ${NONCE} ${label}`;

// Chicago Loop venue, Rockford home: about 80 straight-line miles.
const VENUE = { lat: 41.8781, lng: -87.6298 };
const HOME = { lat: 42.2711, lng: -89.0940 };

const LEGACY_STAFF_KEYS = ['cc_id', 'city', 'created_at', 'display_name', 'email', 'equipment_cooler',
  'equipment_portable_bar', 'equipment_table_with_spandex', 'id', 'import_source', 'onboarding_completed',
  'onboarding_status', 'phone', 'positions_interested', 'preferred_name', 'reliable_transportation', 'role',
  'signed_at', 'state', 'travel_distance'];

let server, baseUrl;
const ids = { users: [], shifts: [], proposals: [], clients: [] };
let adminToken, plainManagerToken;
let near, far, bench;          // staff fixtures
let futureShift, pastShift, todayShift, manualShift, proposalId;

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function makeUser(label, { role = 'staff', canStaff = false, home = null, historical = 0 } = {}) {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, can_staff, token_version)
     VALUES ($1, 'x', $2, 'approved', $3, 0) RETURNING id, token_version`,
    [EMAIL(label), role, canStaff]
  );
  const user = r.rows[0];
  ids.users.push(user.id);
  await pool.query('INSERT INTO onboarding_progress (user_id, onboarding_completed) VALUES ($1, TRUE)', [user.id]);
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, display_name, lat, lng, historical_events_worked)
     VALUES ($1, $2, $2, $3, $4, $5)`,
    [user.id, NAME(label), home ? home.lat : null, home ? home.lng : null, historical]
  );
  return user;
}
const tokenFor = (u) => jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function seedShift({ date, proposal = null, venue = null, positions = '["Bartender","Bartender"]', start = '18:00', end = '23:00' }) {
  const r = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name, positions_needed, proposal_id, lat, lng)
     VALUES ($1::date, $2, $3, 'open', '1 Test St', $4, $5, $6, $7, $8) RETURNING id`,
    [date, start, end, `StaffingMeta ${NONCE}`, positions, proposal, venue ? venue.lat : null, venue ? venue.lng : null]
  );
  ids.shifts.push(r.rows[0].id);
  return r.rows[0].id;
}
async function request(shiftId, userId, { status = 'pending', position = null, ranked = '[]' } = {}) {
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position, requested_positions)
     VALUES ($1, $2, $3, $4, $5)`,
    [shiftId, userId, status, position, ranked]
  );
}
const ymdOffset = (days) => {
  const d = new Date(`${chicagoTodayYmd()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

before(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/shifts', require('./shifts'));
  app.use('/api/admin', require('./admin/users'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    return res.status(500).json({ error: 'Internal error' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });

  adminToken = tokenFor(await makeUser('admin', { role: 'admin' }));
  plainManagerToken = tokenFor(await makeUser('manager', { role: 'manager', canStaff: false }));
  near = await makeUser('near', { home: HOME, historical: 12 });   // 12 imported + 1 live = 13
  far = await makeUser('far');                                     // no home coordinates, nothing worked
  bench = await makeUser('bench', { home: HOME, historical: 3 });  // never requested: a picker candidate

  const c = await pool.query(`INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550000') RETURNING id`,
    [`StaffingMeta ${NONCE}`, EMAIL('client')]);
  ids.clients.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, guest_count, event_type, total_price, amount_paid)
     VALUES ($1, 'deposit_paid', $2::date, 100, 'wedding-reception', 1000, 100) RETURNING id`,
    [c.rows[0].id, ymdOffset(5)]
  );
  proposalId = p.rows[0].id;
  ids.proposals.push(proposalId);

  futureShift = await seedShift({ date: ymdOffset(5), proposal: proposalId, venue: VENUE });
  pastShift = await seedShift({ date: ymdOffset(-10) });
  todayShift = await seedShift({ date: ymdOffset(0), start: '23:00', end: '23:30' });
  manualShift = await seedShift({ date: ymdOffset(7) });           // no proposal, no venue coordinates

  await request(pastShift, near.id, { status: 'approved', position: 'Bartender' });    // the one live event
  await request(todayShift, near.id, { status: 'approved', position: 'Bartender' });   // tonight: not worked yet
  await request(futureShift, near.id, { status: 'pending', ranked: '["Bartender","Barback"]' });
  await request(futureShift, far.id, { status: 'pending', ranked: '[]' });
  await request(manualShift, near.id, { status: 'pending', ranked: '["Bartender"]' });
});

after(async () => {
  await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1::int[])', [ids.shifts]);
  await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [ids.shifts]);
  await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids.proposals]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [ids.clients]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])', [ids.users]);
  await pool.query('DELETE FROM onboarding_progress WHERE user_id = ANY($1::int[])', [ids.users]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids.users]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

const noCoords = (row, where) => {
  for (const k of ['lat', 'lng', 'staff_lat', 'staff_lng']) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, k), false, `${where} must not carry ${k}`);
  }
};

test('detail: requests carry events_worked and the derived distance, never raw coordinates', async () => {
  const r = await get(`/api/shifts/detail/${futureShift}`, adminToken);
  assert.equal(r.status, 200);
  const a = r.body.requests.find((x) => x.user_id === near.id);
  const b = r.body.requests.find((x) => x.user_id === far.id);
  assert.equal(a.events_worked, 13, 'twelve imported plus one live event; tonight does not count');
  assert.equal(b.events_worked, 0);
  assert.ok(a.home_distance_miles > 60 && a.home_distance_miles < 100, `got ${a.home_distance_miles}`);
  assert.equal(b.home_distance_miles, null, 'no home coordinates means no distance');
  r.body.requests.forEach((x) => noCoords(x, 'a detail request'));
});

test('detail: no coordinates on either side yields null, and events_worked still arrives', async () => {
  const r = await get(`/api/shifts/detail/${manualShift}`, adminToken);
  assert.equal(r.status, 200);
  const a = r.body.requests.find((x) => x.user_id === near.id);
  assert.equal(a.home_distance_miles, null, 'the venue has no coordinates');
  assert.equal(a.events_worked, 13);
});

test('detail: finished follows the shift end instant, and the proposal status rides along', async () => {
  const future = await get(`/api/shifts/detail/${futureShift}`, adminToken);
  assert.equal(future.body.shift.finished, false);
  assert.equal(future.body.shift.proposal_status, 'deposit_paid');
  const past = await get(`/api/shifts/detail/${pastShift}`, adminToken);
  assert.equal(past.body.shift.finished, true);
  assert.equal(past.body.shift.proposal_status, null, 'a manual shift has no proposal');
});

test('by-proposal: requesters carry the ranked roles, events_worked and distance; shifts carry finished', async () => {
  const r = await get(`/api/shifts/by-proposal/${proposalId}`, adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  const shift = r.body[0];
  assert.equal(shift.finished, false);
  const a = shift.requesters.find((x) => x.user_id === near.id);
  const b = shift.requesters.find((x) => x.user_id === far.id);
  const ranked = typeof a.requested_positions === 'string' ? JSON.parse(a.requested_positions) : a.requested_positions;
  assert.deepEqual(ranked, ['Bartender', 'Barback']);
  assert.equal(a.events_worked, 13);
  assert.equal(b.events_worked, 0);
  assert.ok(a.home_distance_miles > 60 && a.home_distance_miles < 100);
  shift.requesters.forEach((x) => noCoords(x, 'a by-proposal requester'));
  // What the desktop card reads must still be there.
  for (const k of ['approved_staff', 'approved_by_role', 'request_count', 'approved_count', 'venue_distance_miles']) {
    assert.ok(Object.prototype.hasOwnProperty.call(shift, k), `by-proposal lost ${k}`);
  }
});

test('active-staff without shift_id is frozen at its 20 legacy keys', async () => {
  const r = await get('/api/admin/active-staff?limit=100', adminToken);
  assert.equal(r.status, 200);
  const row = r.body.staff.find((s) => s.id === bench.id);
  assert.ok(row, 'the bench fixture is in the first page');
  assert.deepEqual(Object.keys(row).sort(), LEGACY_STAFF_KEYS);
});

test('active-staff with shift_id adds events_worked and the distance to that venue, never coordinates', async () => {
  const r = await get(`/api/admin/active-staff?limit=100&shift_id=${futureShift}`, adminToken);
  assert.equal(r.status, 200);
  const b = r.body.staff.find((s) => s.id === bench.id);
  const f = r.body.staff.find((s) => s.id === far.id);
  assert.equal(b.events_worked, 3);
  assert.ok(b.home_distance_miles > 60 && b.home_distance_miles < 100, `got ${b.home_distance_miles}`);
  assert.equal(f.events_worked, 0);
  assert.equal(f.home_distance_miles, null);
  assert.deepEqual(Object.keys(b).sort(), [...LEGACY_STAFF_KEYS, 'events_worked', 'home_distance_miles'].sort());
  r.body.staff.forEach((s) => noCoords(s, 'an active-staff row'));
});

test('active-staff with a venue that has no coordinates returns null distances', async () => {
  const r = await get(`/api/admin/active-staff?limit=100&shift_id=${manualShift}`, adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.staff.find((s) => s.id === bench.id).home_distance_miles, null);
});

test('active-staff refuses a malformed shift_id and 404s an unknown one', async () => {
  // The last one passes a digits-only check and overflows int4 in the query.
  for (const bad of ['abc', '0', '-4', '1.5', '', '99999999999']) {
    const r = await get(`/api/admin/active-staff?limit=100&shift_id=${encodeURIComponent(bad)}`, adminToken);
    assert.equal(r.status, 400, `shift_id=${JSON.stringify(bad)} should be a 400`);
  }
  const gone = await get('/api/admin/active-staff?limit=100&shift_id=2147483000', adminToken);
  assert.equal(gone.status, 404);
});

test('a manager without can_staff reaches none of the three reads', async () => {
  assert.equal((await get(`/api/shifts/detail/${futureShift}`, plainManagerToken)).status, 403);
  assert.equal((await get(`/api/shifts/by-proposal/${proposalId}`, plainManagerToken)).status, 403);
  assert.equal((await get(`/api/admin/active-staff?limit=100&shift_id=${futureShift}`, plainManagerToken)).status, 403);
});

test('events_worked is the same number the seniority route reports', async () => {
  const s = await get(`/api/admin/users/${near.id}/seniority`, adminToken);
  assert.equal(s.status, 200);
  const d = await get(`/api/shifts/detail/${futureShift}`, adminToken);
  assert.equal(d.body.requests.find((x) => x.user_id === near.id).events_worked, s.body.events_worked);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/routes/shifts.staffingMeta.test.js`
Expected: the frozen-keys test and the manager test PASS (they describe today's behaviour; if the frozen-keys test fails, STOP: the legacy key list in this plan is wrong and must be corrected from the actual response before anything else changes). Every other test FAILS: `events_worked` is `undefined`, `finished` is `undefined`, `requested_positions` is `undefined`, and `shift_id` is ignored so the 400 and 404 cases answer 200.

- [ ] **Step 3: Create the util**

Create `server/utils/staffingMeta.js`:

```js
'use strict';

// Seniority and proximity facts for the staffing surfaces (spec
// 2026-08-13-mobile-admin section 3, design-session decisions of 2026-09-15):
// how many events a person has worked and how far their home is from a venue,
// shown as plain meta beside an applicant or a picker candidate. Information
// only. Nothing here ranks, sorts or scores; autoAssign.js owns ranking and is
// not a caller.
//
// events_worked has ONE definition and this is its third reader. The other two
// are server/utils/autoAssign.js (step 3) and GET /admin/users/:id/seniority.
// All three count approved, not-dropped requests on shifts dated before the
// CHICAGO business day (never CURRENT_DATE, which is a GMT day and counts
// tonight's shift as worked from 19:00 Chicago), plus the pre-migration
// contractor_profiles.historical_events_worked.
// server/routes/shifts.staffingMeta.test.js pins this reader to the seniority
// route so the three cannot drift silently.
const { pool } = require('../db');
const { chicagoTodayYmd } = require('./businessTime');
const { milesBetween, roundMiles } = require('./serviceArea');

function cleanIds(userIds) {
  return [...new Set((userIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

/** Map of user id -> events worked. A user with no profile and no shifts maps to 0. */
async function loadEventsWorked(userIds, db = pool) {
  const ids = cleanIds(userIds);
  if (ids.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT u.id AS user_id,
            COALESCE(cp.historical_events_worked, 0) + COALESCE(w.live, 0) AS events_worked
       FROM users u
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
       LEFT JOIN (
         SELECT sr.user_id, COUNT(*)::int AS live
           FROM shift_requests sr
           JOIN shifts s ON s.id = sr.shift_id
          WHERE sr.user_id = ANY($1::int[])
            AND sr.status = 'approved'
            AND sr.dropped_at IS NULL
            AND s.event_date < $2::date
          GROUP BY sr.user_id
       ) w ON w.user_id = u.id
      WHERE u.id = ANY($1::int[])`,
    [ids, chicagoTodayYmd()]
  );
  return new Map(rows.map((r) => [Number(r.user_id), Number(r.events_worked)]));
}

/**
 * Picker meta for one shift: for each user id, the events-worked count and the
 * distance from that person's home to THIS shift's venue. The raw home
 * coordinates are read here and never returned. Null when the shift does not
 * exist, so the route can answer 404.
 */
async function candidateMeta(shiftId, userIds, db = pool) {
  const shiftRes = await db.query('SELECT id, lat, lng FROM shifts WHERE id = $1', [shiftId]);
  const shift = shiftRes.rows[0];
  if (!shift) return null;
  const ids = cleanIds(userIds);
  const out = new Map();
  if (ids.length === 0) return out;
  const [worked, homes] = await Promise.all([
    loadEventsWorked(ids, db),
    db.query('SELECT user_id, lat, lng FROM contractor_profiles WHERE user_id = ANY($1::int[])', [ids]),
  ]);
  const homeBy = new Map(homes.rows.map((h) => [Number(h.user_id), h]));
  for (const id of ids) {
    const home = homeBy.get(id);
    out.set(id, {
      events_worked: worked.get(id) ?? 0,
      home_distance_miles: home ? roundMiles(milesBetween(home.lat, home.lng, shift.lat, shift.lng)) : null,
    });
  }
  return out;
}

module.exports = { loadEventsWorked, candidateMeta };
```

- [ ] **Step 4: Extend the two shifts reads**

In `server/routes/shifts.js`, change the import on `:12` and add one below the `shifts.queries` import:

```js
const { shiftNotFinishedSql, shiftFinishedSql } = require('../utils/shiftEndInstant');
```

```js
// Seniority and distance meta for the phone staffing surfaces (lane ma-e2).
const { loadEventsWorked } = require('../utils/staffingMeta');
```

In `GET /by-proposal/:proposalId` (the handler that opens at `:333`), make four edits and no others. **Two of the anchors below also occur in `GET /unstaffed-upcoming`:** `abr.approved_by_role` followed by `FROM shifts s` sits at `:208-209` there and at `:364-365` here. Edit the pair at `:364-365`. An edit applied to the wrong handler still parses, and the test for this step is what tells you.

1. In the `requesters` `json_build_object`, add one pair after `'dropped_at', sr.dropped_at,`:

```sql
                'requested_positions', sr.requested_positions,
```

2. In the outer SELECT list, add one column after `abr.approved_by_role` at `:364` (put a comma after `abr.approved_by_role`):

```sql
      -- Past or not, by the shift END INSTANT in the event zone, never by the
      -- calendar day. The phone roster is read-only once this is true.
      (${shiftFinishedSql('s', 'p')}) AS finished
```

3. Directly after `FROM shifts s` at `:365`, add the join the expression needs:

```sql
    LEFT JOIN proposals p ON p.id = s.proposal_id
```

4. Replace the `res.json(...)` at the end of the handler with:

```js
  const worked = await loadEventsWorked(
    result.rows.flatMap((s) => (Array.isArray(s.requesters) ? s.requesters : []).map((r) => r.user_id))
  );
  res.json(result.rows.map((s) => ({
    ...withOutOfAreaContext(s, s.approved_count),
    requesters: (Array.isArray(s.requesters) ? s.requesters : []).map((r) => ({
      ...withHomeDistance(r, s),
      events_worked: worked.get(Number(r.user_id)) ?? 0,
    })),
  })));
```

In `GET /detail/:id`, add two columns to the first query's SELECT list, after `p.token AS proposal_token,`:

```sql
        p.status AS proposal_status,
        (${shiftFinishedSql('s', 'p')}) AS finished,
```

and replace the closing `res.json(...)` with:

```js
  const worked = await loadEventsWorked(reqResult.rows.map((r) => r.user_id));
  res.json({
    shift: withOutOfAreaContext(shift, shift.approved_count),
    requests: reqResult.rows.map((r) => ({
      ...withHomeDistance(r, shift),
      events_worked: worked.get(Number(r.user_id)) ?? 0,
    })),
  });
```

- [ ] **Step 5: Extend the active-staff read**

In `server/routes/admin/users.js`, add to the imports:

```js
const { candidateMeta } = require('../../utils/staffingMeta');
```

In `GET /active-staff`, directly after the permission check and before `const page`, add:

```js
  // Opt-in picker meta (phone assignment sheet, lane ma-e2). Absent, the
  // response is byte-identical to what every desktop caller reads today.
  const wantsMeta = req.query.shift_id !== undefined;
  const metaShiftId = Number(req.query.shift_id);
  // Digits only, and inside int4: a longer run of digits is a valid Number and
  // an overflow in the query, which would answer 500 instead of 400.
  if (wantsMeta && !(/^\d+$/.test(String(req.query.shift_id)) && metaShiftId > 0 && metaShiftId <= 2147483647)) {
    throw new ValidationError({ shift_id: 'shift_id must be a positive integer.' });
  }
```

and directly before `res.json({ staff: rows, ...`, add:

```js
  if (wantsMeta) {
    const meta = await candidateMeta(metaShiftId, rows.map((r) => r.id));
    if (!meta) throw new NotFoundError('Shift not found.');
    for (const r of rows) {
      const m = meta.get(Number(r.id));
      r.events_worked = m ? m.events_worked : 0;
      r.home_distance_miles = m ? m.home_distance_miles : null;
    }
  }
```

- [ ] **Step 6: Run the test to verify it passes, in both timezones**

Run: `TZ=UTC node --test server/routes/shifts.staffingMeta.test.js` then `TZ=America/Chicago node --test server/routes/shifts.staffingMeta.test.js`
Expected: `# pass 10`, `# fail 0` both times. Read the pass count: a suite that lost its database connection reports a handful of passes and looks like a partial failure.

- [ ] **Step 7: Run the suites this change reaches, one at a time**

```bash
node --test server/routes/shifts.bonus.test.js
node --test server/routes/shifts.adminScoped.test.js
node --test server/routes/shifts.approval.test.js
node --test server/routes/shifts.removeReaccrue.test.js
node --test server/routes/admin/users.activeStaff.test.js
node --test server/routes/admin/users.seniority.test.js
node --test server/utils/autoAssign.seniority.test.js
```

Expected: each green with the pass count it had before this task. `shifts.bonus.test.js` is the one that reads `detail` and `by-proposal` and asserts the coordinate stripping; it must not change.

- [ ] **Step 8: Commit**

```bash
git add server/utils/staffingMeta.js server/routes/shifts.js server/routes/admin/users.js server/routes/shifts.staffingMeta.test.js && git commit -F - <<'MSG'
feat(staffing): events worked, distance and finished on the staffing reads

The phone assignment sheet shows seniority and home-to-venue distance as
plain meta and treats a finished roster as read-only. by-proposal and detail
gain events_worked and finished (by-proposal also the ranked roles);
active-staff gains an opt-in shift_id that adds events_worked and
home_distance_miles. Without shift_id active-staff is frozen at its 20 keys.
Raw home coordinates never leave the server. events_worked is pinned to the
seniority route by test.
MSG
```

---
### Task 2: Service worker allowlist for the detail and sheet reads

> **Built 2026-09-29 as `c6400e3c`, from the text below.** Its review and Checkpoint A found that this design reached desktop screens and stored the whole drink plan. Task 3b replaces it: cached reads are opt-in per request, the drink plan is cached only as a projection, and the by-proposal entry is anchored. Where this section and Task 3b differ, Task 3b is what the lane holds.

**Files:**
- Modify: `client/public/admin-sw.js:30` (version) and `:194-197` (`isAllowlisted`)
- Test: `client/src/utils/adminSwAllowlist.test.js`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: cache-served copies of `GET /api/shifts/detail/:id`, `GET /api/drink-plans/by-proposal/:id` and `GET /api/invoices/proposal/:id` on a transport failure or a 4 second stall, each carrying `x-sw-cached-at`, which `client/src/utils/api.js` surfaces as `res.staleAt`. Tasks 6 and 8 read `res.staleAt` to render the offline states.

- [ ] **Step 1: Write the failing test**

Create `client/src/utils/adminSwAllowlist.test.js`:

```js
import '@testing-library/jest-dom';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

// admin-sw.js is a plain static script, not a module, so it cannot be
// imported. Its top level only declares constants and functions and registers
// listeners on `self`, so it loads in a vm context with a stub `self`, and a
// top-level const is then readable by evaluating its name in that context.
function loadServiceWorker() {
  const src = fs.readFileSync(path.resolve(__dirname, '../../public/admin-sw.js'), 'utf8');
  const self = { addEventListener: () => {}, location: { origin: 'https://admin.example.test' } };
  const context = vm.createContext({ self, caches: {}, fetch: () => Promise.reject(new Error('no network in test')), URL, Response: function Response() {}, Headers: function Headers() {}, console, setTimeout, clearTimeout });
  vm.runInContext(src, context);
  return {
    isAllowlisted: vm.runInContext('isAllowlisted', context),
    version: vm.runInContext('SW_VERSION', context),
  };
}

describe('admin service worker read allowlist', () => {
  const { isAllowlisted, version } = loadServiceWorker();

  test.each([
    '/api/shifts',
    '/api/proposals',
    '/api/proposals/13',
    '/api/shifts/by-proposal/13',
    '/api/admin/badge-counts',
    '/api/admin/search',
    '/api/admin/active-staff',
    '/api/auth/me',
  ])('still caches %s', (p) => {
    expect(isAllowlisted(p)).toBe(true);
  });

  test.each([
    '/api/shifts/detail/17',
    '/api/drink-plans/by-proposal/13',
    '/api/invoices/proposal/13',
  ])('caches the event detail and sheet read %s', (p) => {
    expect(isAllowlisted(p)).toBe(true);
  });

  test.each([
    '/api/shifts/detail/17/extra',
    '/api/shifts/detail/abc',
    '/api/shifts/detail/',
    '/api/shifts/17/requests',
    '/api/shifts/requests/9',
    '/api/drink-plans/13',
    '/api/drink-plans/by-proposal/13/consult',
    '/api/drink-plans/t/0b8f6d2e-1111-4222-8333-444455556666',
    '/api/invoices/13',
    '/api/invoices/proposal/13/extra',
    '/api/invoices/t/0b8f6d2e-1111-4222-8333-444455556666',
    '/api/proposals/13/cancel-line/targets',
    '/api/proposals/t/0b8f6d2e-1111-4222-8333-444455556666',
    '/api/proposals/financials',
    '/api/stripe/refunds/13',
    '/api/admin/users/12/seniority',
    '/api/admin/active-staff/extra',
  ])('never caches %s', (p) => {
    expect(isAllowlisted(p)).toBe(false);
  });

  test('the version was bumped so installed phones pick the new allowlist up', () => {
    expect(version).not.toBe('admin-sw-2026-08-14-v8');
    expect(version).toMatch(/^admin-sw-\d{4}-\d{2}-\d{2}-v9$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/adminSwAllowlist.test.js`
Expected: the eight "still caches" cases and the seventeen "never caches" cases PASS; the three "caches the event detail and sheet read" cases FAIL with `expected true, received false`; the version test FAILS.

- [ ] **Step 3: Extend the allowlist and bump the version**

In `client/public/admin-sw.js`, replace line 30:

```js
const SW_VERSION = 'admin-sw-2026-09-29-v9';
```

and replace the `isAllowlisted` definition (`:194-197`) with:

```js
const isAllowlisted = (pathname) =>
  API_EXACT.has(pathname) ||
  /^\/api\/proposals\/\d+$/.test(pathname) ||
  pathname.startsWith('/api/shifts/by-proposal/') ||
  // Phone event detail and assignment sheet (lane ma-e2). Anchored on both
  // ends and numeric-id only, so no token route and no sub-resource can ride
  // in. The invoices read is cached on purpose: it carries the bank debit in
  // flight, and an offline detail showing a plain balance while a debit is
  // settling is how a client gets chased for money already on its way.
  /^\/api\/shifts\/detail\/\d+$/.test(pathname) ||
  /^\/api\/drink-plans\/by-proposal\/\d+$/.test(pathname) ||
  /^\/api\/invoices\/proposal\/\d+$/.test(pathname);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/adminSwAllowlist.test.js`
Expected: PASS, 29 tests.

- [ ] **Step 5: Run the suite that guards the purge contract**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/adminSw.purge.test.js`
Expected: PASS, unchanged. That suite covers the CLIENT-side purge (`purgeMobileAdminState`). The service worker's own activate sweep, which drops the v8 caches by their `admin-api-` and `admin-shell-` prefixes when v9 takes over, has no unit test; it is checked in the browser gate (Task 10, D12).

- [ ] **Step 6: Commit**

```bash
git add client/public/admin-sw.js client/src/utils/adminSwAllowlist.test.js && git commit -F - <<'MSG'
feat(admin-sw): cache the event detail and assignment sheet reads, v9

Three numeric-id reads join the allowlist: shifts/detail, drink-plans
by-proposal, invoices by proposal. Anchored patterns, so no token route and
no sub-resource matches. The allowlist now has a test, loaded through vm.
MSG
```

Report to the orchestrator that the contract is ready: Checkpoint A (in the header) runs before Task 3 is dispatched.

---

### Task 3: Push-history option on `useDrawerParam`

> **Built 2026-09-29 as `1e9bb783`, from the text below, review clean.** Task 3b adds one guard (the seed runs only for a numeric sheet id) and three tests the review asked for. Where this section and Task 3b differ, Task 3b is what the lane holds.

**Files:**
- Modify: `client/src/hooks/useDrawerParam.js`
- Test: `client/src/hooks/useDrawerParam.test.js` (new; the hook has no test today)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `useDrawerParam({ push = false, kinds = null } = {}) -> { kind, id, focus, open, close }`.
  - `kinds` is the list of drawer kinds that are phone sheets, for example `['shift']`. Push behaviour applies to those kinds only; `null` means every kind. Callers pass a module-scope array.
  - `open(kind, id, { focus } = {})` writes `?drawer=<kind>&drawerId=<id>` and, when `focus` is given, `&drawerFocus=<focus>`. With `push: false` (the default, every desktop caller), or for a kind that is not listed, it REPLACES the history entry exactly as today. With `push: true` and a listed kind it PUSHES an entry carrying `location.state.mSheet === true`.
  - `close()` goes back one entry when the entry carries that flag AND something sits behind it (`window.history.state.idx > 0`; unknown position counts as yes). Otherwise it replaces the entry with the three drawer params removed.
  - With `push: true`, a location that arrives with a listed kind and no `mSheet` state (deep link, cold route restore) has one entry seeded behind it, so Back closes the sheet and stays on the page.
  - `focus` is `string | null`.
  - The named export `drawerHref(searchParams, kind, id)` is unchanged.

- [ ] **Step 1: Write the failing test**

Create `client/src/hooks/useDrawerParam.test.js`:

```js
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import useDrawerParam from './useDrawerParam';

// Back is navigate(-1): the same history pop Android's hardware Back fires.
function Probe({ push }) {
  const drawer = useDrawerParam(push ? { push: true, kinds: ['shift'] } : undefined);
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <div data-testid="loc">{location.pathname + location.search}</div>
      <div data-testid="kind">{drawer.kind || 'none'}</div>
      <div data-testid="id">{drawer.id || 'none'}</div>
      <div data-testid="focus">{drawer.focus || 'none'}</div>
      <button type="button" onClick={() => drawer.open('shift', 17)}>open</button>
      <button type="button" onClick={() => drawer.open('shift', 17, { focus: 42 })}>open-focused</button>
      <button type="button" onClick={() => drawer.open('invoices', 13)}>open-invoices</button>
      <button type="button" onClick={() => drawer.close()}>close</button>
      <button type="button" onClick={() => navigate(-1)}>back</button>
    </div>
  );
}
function Before() { return <div data-testid="loc">/before</div>; }

function mount({ push, entries = ['/before', '/events?scope=past'], index = entries.length - 1 }) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      <Routes>
        <Route path="/before" element={<Before />} />
        <Route path="/events" element={<Probe push={push} />} />
      </Routes>
    </MemoryRouter>
  );
}
const loc = () => screen.getByTestId('loc').textContent;
const tap = (name) => fireEvent.click(screen.getByRole('button', { name }));

test('the default keeps replace semantics: Back after open leaves the page', async () => {
  mount({ push: false });
  tap('open');
  await waitFor(() => expect(loc()).toBe('/events?scope=past&drawer=shift&drawerId=17'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('push mode: Back closes the sheet and stays on the page', async () => {
  mount({ push: true });
  tap('open');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  expect(screen.getByTestId('id')).toHaveTextContent('17');
  tap('back');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  expect(screen.getByTestId('kind')).toHaveTextContent('none');
});

test('push mode: close() pops the entry it pushed, so no entry piles up', async () => {
  mount({ push: true });
  tap('open');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  tap('close');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('push mode: opening, closing and opening again still leaves one entry behind the sheet', async () => {
  mount({ push: true });
  tap('open');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  tap('close');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('none'));
  tap('open');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('a deep-linked sheet gets an entry seeded behind it', async () => {
  mount({ push: true, entries: ['/before', '/events?scope=past&drawer=shift&drawerId=17'] });
  expect(screen.getByTestId('kind')).toHaveTextContent('shift');
  await waitFor(() => expect(loc()).toBe('/events?scope=past&drawer=shift&drawerId=17'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  expect(screen.getByTestId('kind')).toHaveTextContent('none');
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('a deep-linked sheet closed with close() lands on the bare page, one Back from where it came', async () => {
  mount({ push: true, entries: ['/before', '/events?drawer=shift&drawerId=17'] });
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  tap('close');
  await waitFor(() => expect(loc()).toBe('/events'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('the default never seeds: a deep-linked desktop drawer keeps its single entry', async () => {
  mount({ push: false, entries: ['/before', '/events?drawer=shift&drawerId=17'] });
  expect(screen.getByTestId('kind')).toHaveTextContent('shift');
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('focus rides the URL and clears with the sheet', async () => {
  mount({ push: true });
  tap('open-focused');
  await waitFor(() => expect(screen.getByTestId('focus')).toHaveTextContent('42'));
  expect(loc()).toBe('/events?scope=past&drawer=shift&drawerId=17&drawerFocus=42');
  tap('close');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  expect(screen.getByTestId('focus')).toHaveTextContent('none');
});

test('opening without a focus drops a focus left over from an earlier open', async () => {
  mount({ push: false, entries: ['/events?drawer=shift&drawerId=9&drawerFocus=42'] });
  tap('open');
  await waitFor(() => expect(loc()).toBe('/events?drawer=shift&drawerId=17'));
});

test('a kind that is not a sheet keeps replace semantics and is never seeded, even in push mode', async () => {
  mount({ push: true });
  tap('open-invoices');
  await waitFor(() => expect(loc()).toBe('/events?scope=past&drawer=invoices&drawerId=13'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('a deep link to a kind that is not a sheet gains no history entry', async () => {
  mount({ push: true, entries: ['/before', '/events?drawer=invoices&drawerId=13'] });
  expect(screen.getByTestId('kind')).toHaveTextContent('invoices');
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

describe('against the real browser history', () => {
  afterEach(() => { window.history.replaceState(null, '', '/'); });

  test('an entry that claims it was pushed but has nothing behind it still closes', async () => {
    // What a duplicated tab or a trimmed history leaves: the flag, at index 0.
    window.history.replaceState({ usr: { mSheet: true }, key: 'orphan', idx: 0 }, '', '/events?scope=past&drawer=shift&drawerId=17');
    render(
      <BrowserRouter>
        <Routes><Route path="/events" element={<Probe push />} /></Routes>
      </BrowserRouter>
    );
    expect(screen.getByTestId('kind')).toHaveTextContent('shift');
    tap('close');
    await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('none'));
    expect(window.location.pathname + window.location.search).toBe('/events?scope=past');
  });

  test('open pushes exactly one entry and close pops it', async () => {
    window.history.replaceState(null, '', '/events?scope=past');
    render(
      <BrowserRouter>
        <Routes><Route path="/events" element={<Probe push />} /></Routes>
      </BrowserRouter>
    );
    const before = window.history.length;
    tap('open');
    await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
    expect(window.history.length).toBe(before + 1);
    tap('close');
    await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('none'));
    expect(window.location.pathname + window.location.search).toBe('/events?scope=past');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/hooks/useDrawerParam.test.js`
Expected: `Tests: 6 failed, 7 passed, 13 total` (measured against today's hook in a scratch copy, 2026-09-29). The seven that PASS describe behaviour today's replace-only hook already has, and they must keep passing: both default-mode tests, both non-sheet-kind tests, the two `close()` tests (closing by replace lands on the same URL), and the orphan entry. The six that FAIL: "Back closes the sheet", "opening, closing and opening again", "a deep-linked sheet gets an entry seeded", both focus tests, and "open pushes exactly one entry". Do not "fix" a passing test.

- [ ] **Step 3: Implement the option**

Replace the whole of `client/src/hooks/useDrawerParam.js` with:

```js
import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

// location.state flag on a history entry this hook pushed. close() reads it to
// know whether going back one entry is safe.
const SHEET_STATE = 'mSheet';
const KEYS = ['drawer', 'drawerId', 'drawerFocus'];

function withoutDrawer(params) {
  const next = new URLSearchParams(params);
  KEYS.forEach((k) => next.delete(k));
  return next;
}

// Is there an entry behind this one? BrowserRouter keeps its position in
// window.history.state.idx. Where that is unknown (MemoryRouter in tests) the
// answer is yes, because the flag on the entry is then the only evidence.
function canGoBack() {
  const state = typeof window !== 'undefined' && window.history ? window.history.state : null;
  if (!state || typeof state.idx !== 'number') return true;
  return state.idx > 0;
}

/**
 * URL-synced drawer state. Reads/writes `?drawer=<kind>&drawerId=<id>` and the
 * optional `&drawerFocus=<id>`. Layered on top of whatever other query params
 * the page uses, never touching them.
 *
 * Usage:
 *   const drawer = useDrawerParam();
 *   drawer.kind  === 'event' when a drawer is open
 *   drawer.id    === '<id>' when a drawer is open
 *   drawer.open('event', e.id)
 *   drawer.close()
 *
 * Two history behaviours:
 *
 * DEFAULT (every desktop caller): open and close REPLACE the current entry. A
 * drawer is page state, not a navigation. Pushing made every open and every
 * close stack a history entry, so the Back button walked through drawer-toggle
 * states (re-opening drawers in a loop) instead of returning to the previous
 * page. Keep both `replace: true`.
 *
 * `{ push: true, kinds: ['shift'] }` (phone bottom sheets, spec
 * 2026-08-13-mobile-admin section 3): for the listed kinds, open PUSHES one
 * entry, so Android's hardware Back closes the sheet and stays on the page.
 * close() pops that same entry, so opening and closing a sheet any number of
 * times leaves history exactly as it found it. A sheet that arrives by deep
 * link or cold route restore has no entry behind it, so one is seeded: the
 * current entry is replaced by the bare page and the sheet is pushed on top.
 * A kind that is not listed keeps the default, so a desktop drawer link opened
 * on the phone never gains an entry for a sheet that does not exist. Omitting
 * `kinds` pushes for every kind.
 */
export default function useDrawerParam({ push = false, kinds = null } = {}) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const kind = params.get('drawer');
  const id = params.get('drawerId');
  const focus = params.get('drawerFocus');
  const pushed = !!(location.state && location.state[SHEET_STATE]);
  // A string, so an inline array from the caller cannot churn the callbacks.
  const kindList = Array.isArray(kinds) ? kinds.join(',') : null;
  const pushes = useCallback(
    (k) => push && (kindList === null || kindList.split(',').includes(k)),
    [push, kindList]
  );

  const open = useCallback((newKind, newId, { focus: newFocus } = {}) => {
    const next = new URLSearchParams(params);
    next.set('drawer', newKind);
    next.set('drawerId', String(newId));
    if (newFocus === undefined || newFocus === null) next.delete('drawerFocus');
    else next.set('drawerFocus', String(newFocus));
    if (pushes(newKind)) setParams(next, { state: { [SHEET_STATE]: true } });
    else setParams(next, { replace: true });
  }, [params, setParams, pushes]);

  const close = useCallback(() => {
    // Pop only an entry this hook pushed AND that has something behind it. An
    // entry that carries the flag with nothing behind it (a duplicated tab, a
    // history the browser trimmed) would otherwise never close.
    if (pushed && pushes(kind) && canGoBack()) { navigate(-1); return; }
    setParams(withoutDrawer(params), { replace: true });
  }, [params, setParams, pushes, pushed, kind, navigate]);

  // Seed an entry behind a sheet that has none. The ref latch is what makes
  // this safe under StrictMode, which runs an effect twice with the same
  // closure: the second run sees the same location.key and stops.
  const seededFor = useRef(null);
  useEffect(() => {
    if (!kind || !id || pushed || !pushes(kind)) return;
    if (seededFor.current === location.key) return;
    seededFor.current = location.key;
    const bare = withoutDrawer(params).toString();
    navigate({ pathname: location.pathname, search: bare ? `?${bare}` : '' }, { replace: true });
    navigate({ pathname: location.pathname, search: location.search }, { state: { [SHEET_STATE]: true } });
    // params is derived from location.search, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushes, kind, id, pushed, location.key, location.pathname, location.search, navigate]);

  return { kind, id, focus, open, close };
}

// Builds a same-page href that opens a drawer, preserving all other query
// params. For real links (cmd-click new tab) instead of onClick drawer.open.
export function drawerHref(searchParams, kind, id) {
  const next = new URLSearchParams(searchParams);
  next.set('drawer', kind);
  next.set('drawerId', String(id));
  return `?${next.toString()}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/hooks/useDrawerParam.test.js`
Expected: PASS, 13 tests. The two navigations in one effect were proven against react-router 6.30 before this plan was cut (plain history, the data router, `BrowserRouter` on jsdom and under StrictMode): the stack ends `[..., bare page, sheet]`, and StrictMode seeds once.

- [ ] **Step 5: Run the suites that use the hook**

```bash
cd client && CI=true npx react-scripts test --watchAll=false src/pages/mobile/EventsListPhone.test.js src/pages/admin/EventsDashboard.fork.test.js src/hooks/useUrlListState.test.js
```

Expected: PASS, unchanged counts. These cover the replace-mode callers.

- [ ] **Step 6: Build and commit**

```bash
cd client && CI=true npx react-scripts build && cd .. && git add client/src/hooks/useDrawerParam.js client/src/hooks/useDrawerParam.test.js && git commit -F - <<'MSG'
feat(hooks): push-history option on useDrawerParam for phone sheets

With push true, open pushes one history entry for the listed sheet kinds so
Android Back closes the sheet and stays on the page, close pops that entry
when something sits behind it, and a sheet that arrives by deep link or cold
route restore gets an entry seeded behind it. The default is unchanged:
every desktop caller keeps replace semantics, and so does any kind that is
not a sheet. Adds the optional drawerFocus param and the hook's first test
file.
MSG
```

---
### Task 3b: Checkpoint A fold: the contract as amended

Checkpoint A ran on Tasks 1 and 2 on 2026-09-29. The database review passed. The security review failed, narrowly, and the Task 2 review raised one plan-level finding. This task brings what Tasks 1, 2 and 3 built to the amended contract, BEFORE any client task consumes it. The reasons are in the header (Decisions 19 to 22); the code is below.

What changes, in one paragraph: the service worker stores and stale-serves a read only when the request asks for it with `X-Offline-Ok: 1`, so desktop screens never see cached data; the drink plan is read and cached only as a two-field projection; the picker's distances are whole miles; the two shifts reads answer 400 for a malformed id; the by-proposal allowlist entry is anchored; the hook seeds a history entry only for a numeric sheet id; and Task 1's test gains the fixtures three reviewers asked for.

**Files:**
- Modify: `server/utils/staffingMeta.js` (replaced whole)
- Modify: `server/routes/shifts.js` (one helper after `clampInt` `:42-46`; `GET /by-proposal/:proposalId`; `GET /detail/:id`)
- Modify: `server/routes/drinkPlans.js` (`GET /by-proposal/:proposalId` `:381`)
- Modify: `client/public/admin-sw.js` (`isAllowlisted` `:194-205`; the API branch condition `:296`)
- Modify: `client/src/hooks/useDrawerParam.js` (replaced whole)
- Create: `client/src/utils/offlineRead.js`
- Test: `server/routes/shifts.staffingMeta.test.js` (replaced whole), `server/routes/drinkPlans.dayOfContact.test.js` (new), `client/src/utils/adminSwAllowlist.test.js` (replaced whole), `client/src/utils/offlineRead.test.js` (new), `client/src/hooks/useDrawerParam.test.js` (replaced whole)

**Interfaces:**
- Consumes: what Tasks 1, 2 and 3 committed (`df5f8d28`, `c6400e3c`, `1e9bb783`).
- Produces, for Tasks 4, 6, 7, 8b and 9 (these REPLACE what the Task 1 and Task 2 sections say where they differ):
  - `GET /admin/active-staff?limit=100&shift_id=<id>`: `home_distance_miles` is a WHOLE number of miles or `null`. The two shifts reads keep a tenth of a mile for requesters.
  - `GET /shifts/detail/:id` and `GET /shifts/by-proposal/:proposalId` answer 400 when the path id is not a positive integer within int4.
  - `GET /drink-plans/by-proposal/:proposalId?fields=day_of_contact` -> `{ day_of_contact: { name, phone } | null }`, 404 when the proposal has no drink plan, 400 for any other `fields` value or a malformed id. Without `fields` the response is unchanged.
  - `client/src/utils/offlineRead.js` exports `offlineGet(url, config?) -> Promise<response>` (it is `api.get` plus the header `X-Offline-Ok: 1`) and `OFFLINE_OK_HEADER`. The response carries `res.staleAt` when the service worker served it.
  - The service worker handles a GET only when the path is allowlisted AND the request carries `X-Offline-Ok: 1` (or the path is `/api/auth/me`). `/api/drink-plans/by-proposal/:id` is allowlisted only with the exact query `?fields=day_of_contact`.
  - `useDrawerParam` seeds an entry behind a deep-linked sheet only when `drawerId` is all digits.

- [ ] **Step 1: Replace and add the server tests**

Replace the whole of `server/routes/shifts.staffingMeta.test.js` with:

```js
// Staffing meta on the three reads the phone staffing surfaces use (lane
// ma-e2, spec 2026-08-13-mobile-admin sections 3 and 4).
//
// Three kinds of claim, kept apart on purpose:
//   1. ADDITIVE. The two shifts reads gain events_worked, finished and (on
//      by-proposal) requested_positions. Nothing they returned before moves.
//   2. FROZEN. GET /admin/active-staff without shift_id returns exactly the
//      20 keys it returned before this lane. The desktop drawer, the roster and
//      the reviews page all read that shape.
//   3. ONE DEFINITION. events_worked here equals GET /admin/users/:id/seniority
//      for the same person, across every filter the definition has, so this
//      third reader cannot drift from the two that feed auto-assign.
// And two privacy laws: no response carries a person's raw home coordinates,
// and the picker's distances are whole miles.

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { chicagoTodayYmd } = require('../utils/businessTime');
const { wholeMiles } = require('../utils/staffingMeta');

if (process.env.NODE_ENV === 'production') {
  throw new Error('shifts.staffingMeta.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = (label) => `staffing-meta-${NONCE}-${label}@example.com`;
// Sorts to the top of the alphabetical active-staff feed, so the fixtures are
// inside the first 100 rows however many staff the dev database holds.
const NAME = (label) => `AAA ${NONCE} ${label}`;

// Chicago Loop venue, Rockford home: about 80 straight-line miles.
const VENUE = { lat: 41.8781, lng: -87.6298 };
const HOME = { lat: 42.2711, lng: -89.0940 };

const LEGACY_STAFF_KEYS = ['cc_id', 'city', 'created_at', 'display_name', 'email', 'equipment_cooler',
  'equipment_portable_bar', 'equipment_table_with_spandex', 'id', 'import_source', 'onboarding_completed',
  'onboarding_status', 'phone', 'positions_interested', 'preferred_name', 'reliable_transportation', 'role',
  'signed_at', 'state', 'travel_distance'];

let server, baseUrl;
const ids = { users: [], shifts: [], proposals: [], clients: [] };
let adminToken, plainManagerToken;
let near, far, bench, bare, twice;   // staff fixtures
let futureShift, pastShift, todayShift, manualShift, proposalId;

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function makeUser(label, { role = 'staff', canStaff = false, home = null, historical = 0, profile = true } = {}) {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, can_staff, token_version)
     VALUES ($1, 'x', $2, 'approved', $3, 0) RETURNING id, token_version`,
    [EMAIL(label), role, canStaff]
  );
  const user = r.rows[0];
  ids.users.push(user.id);
  await pool.query('INSERT INTO onboarding_progress (user_id, onboarding_completed) VALUES ($1, TRUE)', [user.id]);
  if (profile) {
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, preferred_name, display_name, lat, lng, historical_events_worked)
       VALUES ($1, $2, $2, $3, $4, $5)`,
      [user.id, NAME(label), home ? home.lat : null, home ? home.lng : null, historical]
    );
  }
  return user;
}
const tokenFor = (u) => jwt.sign({ userId: u.id, tokenVersion: u.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function seedProposal(date) {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, guest_count, event_type, total_price, amount_paid)
     VALUES ($1, 'deposit_paid', $2::date, 100, 'wedding-reception', 1000, 100) RETURNING id`,
    [ids.clients[0], date]
  );
  ids.proposals.push(p.rows[0].id);
  return p.rows[0].id;
}
async function seedShift({ date, proposal = null, venue = null, positions = '["Bartender","Bartender"]', start = '18:00', end = '23:00' }) {
  const r = await pool.query(
    `INSERT INTO shifts (event_date, start_time, end_time, status, location, client_name, positions_needed, proposal_id, lat, lng)
     VALUES ($1::date, $2, $3, 'open', '1 Test St', $4, $5, $6, $7, $8) RETURNING id`,
    [date, start, end, `StaffingMeta ${NONCE}`, positions, proposal, venue ? venue.lat : null, venue ? venue.lng : null]
  );
  ids.shifts.push(r.rows[0].id);
  return r.rows[0].id;
}
async function request(shiftId, userId, { status = 'pending', position = null, ranked = '[]', dropped = false } = {}) {
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position, requested_positions, dropped_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [shiftId, userId, status, position, ranked, dropped ? new Date() : null]
  );
}
const ymdOffset = (days) => {
  const d = new Date(`${chicagoTodayYmd()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

before(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/shifts', require('./shifts'));
  app.use('/api/admin', require('./admin/users'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    return res.status(500).json({ error: 'Internal error' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });

  adminToken = tokenFor(await makeUser('admin', { role: 'admin' }));
  plainManagerToken = tokenFor(await makeUser('manager', { role: 'manager', canStaff: false }));
  near = await makeUser('near', { home: HOME, historical: 12 });   // 12 imported + 1 live = 13
  far = await makeUser('far');                                     // no home coordinates, nothing worked
  bench = await makeUser('bench', { home: HOME, historical: 3 });  // never requested: a picker candidate
  bare = await makeUser('bare', { profile: false });               // no contractor profile at all
  twice = await makeUser('twice');                                 // two shifts of ONE past event

  const c = await pool.query(`INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550000') RETURNING id`,
    [`StaffingMeta ${NONCE}`, EMAIL('client')]);
  ids.clients.push(c.rows[0].id);
  proposalId = await seedProposal(ymdOffset(5));
  const pastProposal = await seedProposal(ymdOffset(-20));

  futureShift = await seedShift({ date: ymdOffset(5), proposal: proposalId, venue: VENUE });
  pastShift = await seedShift({ date: ymdOffset(-10) });
  todayShift = await seedShift({ date: ymdOffset(0), start: '23:00', end: '23:30' });
  manualShift = await seedShift({ date: ymdOffset(7) });           // no proposal, no venue coordinates
  const pastDropped = await seedShift({ date: ymdOffset(-11) });
  const pastPending = await seedShift({ date: ymdOffset(-12) });
  const pastDenied = await seedShift({ date: ymdOffset(-13) });
  const pastA = await seedShift({ date: ymdOffset(-20), proposal: pastProposal, start: '16:00', end: '20:00' });
  const pastB = await seedShift({ date: ymdOffset(-20), proposal: pastProposal, start: '20:00', end: '23:00' });

  // near: exactly ONE row counts. Each of the others trips one filter.
  await request(pastShift, near.id, { status: 'approved', position: 'Bartender' });                     // counts
  await request(todayShift, near.id, { status: 'approved', position: 'Bartender' });                    // tonight: not yet
  await request(pastDropped, near.id, { status: 'approved', position: 'Bartender', dropped: true });    // emergency drop
  await request(pastPending, near.id, { status: 'pending', ranked: '["Bartender"]' });                  // never approved
  await request(pastDenied, near.id, { status: 'denied' });                                             // denied
  await request(futureShift, near.id, { status: 'pending', ranked: '["Bartender","Barback"]' });
  await request(futureShift, far.id, { status: 'pending', ranked: '[]' });
  await request(futureShift, bare.id, { status: 'pending', ranked: '["Bartender"]' });
  await request(manualShift, near.id, { status: 'pending', ranked: '["Bartender"]' });
  await request(pastA, twice.id, { status: 'approved', position: 'Bartender' });
  await request(pastB, twice.id, { status: 'approved', position: 'Bartender' });
  await request(futureShift, twice.id, { status: 'pending', ranked: '["Bartender"]' });
});

after(async () => {
  await pool.query('DELETE FROM shift_requests WHERE shift_id = ANY($1::int[])', [ids.shifts]);
  await pool.query('DELETE FROM shifts WHERE id = ANY($1::int[])', [ids.shifts]);
  await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids.proposals]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [ids.clients]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])', [ids.users]);
  await pool.query('DELETE FROM onboarding_progress WHERE user_id = ANY($1::int[])', [ids.users]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids.users]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

const noCoords = (row, where) => {
  for (const k of ['lat', 'lng', 'staff_lat', 'staff_lng']) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, k), false, `${where} must not carry ${k}`);
  }
};

test('detail: requests carry events_worked and the derived distance, never raw coordinates', async () => {
  const r = await get(`/api/shifts/detail/${futureShift}`, adminToken);
  assert.equal(r.status, 200);
  const a = r.body.requests.find((x) => x.user_id === near.id);
  const b = r.body.requests.find((x) => x.user_id === far.id);
  assert.equal(a.events_worked, 13, 'twelve imported plus one live event; tonight, a drop, a pending and a denied do not count');
  assert.equal(b.events_worked, 0);
  assert.ok(a.home_distance_miles > 60 && a.home_distance_miles < 100, `got ${a.home_distance_miles}`);
  assert.equal(b.home_distance_miles, null, 'no home coordinates means no distance');
  r.body.requests.forEach((x) => noCoords(x, 'a detail request'));
  // What the desktop drawer reads must still be there.
  for (const k of ['id', 'user_id', 'status', 'position', 'dropped_at', 'requested_positions', 'staff_name', 'staff_email', 'staff_city', 'staff_reliable_transportation']) {
    assert.ok(Object.prototype.hasOwnProperty.call(a, k), `detail request lost ${k}`);
  }
  for (const k of ['client_name', 'client_phone', 'client_email', 'proposal_total', 'request_count', 'approved_count', 'venue_distance_miles', 'positions_needed']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r.body.shift, k), `detail shift lost ${k}`);
  }
});

test('a requester with no contractor profile still gets a row: zero events, no distance, a name', async () => {
  const r = await get(`/api/shifts/detail/${futureShift}`, adminToken);
  const x = r.body.requests.find((q) => q.user_id === bare.id);
  assert.ok(x, 'the profile-less requester is in the list');
  assert.equal(x.events_worked, 0);
  assert.equal(x.home_distance_miles, null);
  assert.equal(x.staff_name, EMAIL('bare'), 'the name falls back to the email');
  const p = await get(`/api/shifts/by-proposal/${proposalId}`, adminToken);
  const y = p.body[0].requesters.find((q) => q.user_id === bare.id);
  assert.equal(y.events_worked, 0);
  assert.equal(y.home_distance_miles, null);
});

test('events worked counts SHIFTS: two shifts of one event count two', async () => {
  const r = await get(`/api/shifts/detail/${futureShift}`, adminToken);
  assert.equal(r.body.requests.find((q) => q.user_id === twice.id).events_worked, 2);
  const s = await get(`/api/admin/users/${twice.id}/seniority`, adminToken);
  assert.equal(s.body.events_worked, 2, 'the seniority route counts the same way');
});

test('detail: no coordinates on either side yields null, and events_worked still arrives', async () => {
  const r = await get(`/api/shifts/detail/${manualShift}`, adminToken);
  assert.equal(r.status, 200);
  const a = r.body.requests.find((x) => x.user_id === near.id);
  assert.equal(a.home_distance_miles, null, 'the venue has no coordinates');
  assert.equal(a.events_worked, 13);
});

test('detail: finished follows the shift end instant, and the proposal status rides along', async () => {
  const future = await get(`/api/shifts/detail/${futureShift}`, adminToken);
  assert.equal(future.body.shift.finished, false);
  assert.equal(future.body.shift.proposal_status, 'deposit_paid');
  const past = await get(`/api/shifts/detail/${pastShift}`, adminToken);
  assert.equal(past.body.shift.finished, true);
  assert.equal(past.body.shift.proposal_status, null, 'a manual shift has no proposal');
});

test('by-proposal: requesters carry the ranked roles, events_worked and distance; shifts carry finished', async () => {
  const r = await get(`/api/shifts/by-proposal/${proposalId}`, adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  const shift = r.body[0];
  assert.equal(shift.finished, false);
  const a = shift.requesters.find((x) => x.user_id === near.id);
  const b = shift.requesters.find((x) => x.user_id === far.id);
  const ranked = typeof a.requested_positions === 'string' ? JSON.parse(a.requested_positions) : a.requested_positions;
  assert.deepEqual(ranked, ['Bartender', 'Barback']);
  assert.equal(a.events_worked, 13);
  assert.equal(b.events_worked, 0);
  assert.ok(a.home_distance_miles > 60 && a.home_distance_miles < 100);
  shift.requesters.forEach((x) => noCoords(x, 'a by-proposal requester'));
  // What the desktop card reads must still be there.
  for (const k of ['approved_staff', 'approved_by_role', 'request_count', 'approved_count', 'venue_distance_miles']) {
    assert.ok(Object.prototype.hasOwnProperty.call(shift, k), `by-proposal lost ${k}`);
  }
});

test('a malformed path id answers 400 on both shifts reads, never 500', async () => {
  for (const bad of ['abc', '0', '-4', '1.5', '99999999999']) {
    assert.equal((await get(`/api/shifts/detail/${bad}`, adminToken)).status, 400, `detail/${bad}`);
    assert.equal((await get(`/api/shifts/by-proposal/${bad}`, adminToken)).status, 400, `by-proposal/${bad}`);
  }
  assert.equal((await get('/api/shifts/detail/2147483000', adminToken)).status, 404, 'a well-formed id that matches nothing');
  assert.deepEqual((await get('/api/shifts/by-proposal/2147483000', adminToken)).body, [], 'a proposal with no shifts');
});

test('active-staff without shift_id is frozen at its 20 legacy keys', async () => {
  const r = await get('/api/admin/active-staff?limit=100', adminToken);
  assert.equal(r.status, 200);
  const row = r.body.staff.find((s) => s.id === bench.id);
  assert.ok(row, 'the bench fixture is in the first page');
  assert.deepEqual(Object.keys(row).sort(), LEGACY_STAFF_KEYS);
});

test('active-staff with shift_id adds events_worked and a WHOLE-mile distance to that venue, never coordinates', async () => {
  const r = await get(`/api/admin/active-staff?limit=100&shift_id=${futureShift}`, adminToken);
  assert.equal(r.status, 200);
  const b = r.body.staff.find((s) => s.id === bench.id);
  const f = r.body.staff.find((s) => s.id === far.id);
  assert.equal(b.events_worked, 3);
  assert.ok(b.home_distance_miles > 60 && b.home_distance_miles < 100, `got ${b.home_distance_miles}`);
  assert.equal(f.events_worked, 0);
  assert.equal(f.home_distance_miles, null);
  assert.deepEqual(Object.keys(b).sort(), [...LEGACY_STAFF_KEYS, 'events_worked', 'home_distance_miles'].sort());
  for (const s of r.body.staff) {
    noCoords(s, 'an active-staff row');
    assert.ok(s.home_distance_miles === null || Number.isInteger(s.home_distance_miles),
      `picker distances are whole miles, got ${s.home_distance_miles}`);
  }
});

test('wholeMiles rounds to the mile and keeps null as null', () => {
  assert.equal(wholeMiles(6.8), 7);
  assert.equal(wholeMiles(6.44), 6);
  assert.equal(wholeMiles(0.3), 0);
  assert.equal(wholeMiles(null), null);
  assert.equal(wholeMiles(undefined), null);
  assert.equal(wholeMiles(Number.NaN), null);
});

test('active-staff with a venue that has no coordinates returns null distances', async () => {
  const r = await get(`/api/admin/active-staff?limit=100&shift_id=${manualShift}`, adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.staff.find((s) => s.id === bench.id).home_distance_miles, null);
});

test('active-staff refuses a malformed shift_id and 404s an unknown one', async () => {
  // The last one passes a digits-only check and overflows int4 in the query.
  for (const bad of ['abc', '0', '-4', '1.5', '', '99999999999']) {
    const r = await get(`/api/admin/active-staff?limit=100&shift_id=${encodeURIComponent(bad)}`, adminToken);
    assert.equal(r.status, 400, `shift_id=${JSON.stringify(bad)} should be a 400`);
  }
  const gone = await get('/api/admin/active-staff?limit=100&shift_id=2147483000', adminToken);
  assert.equal(gone.status, 404);
});

test('a manager without can_staff reaches none of the three reads', async () => {
  assert.equal((await get(`/api/shifts/detail/${futureShift}`, plainManagerToken)).status, 403);
  assert.equal((await get(`/api/shifts/by-proposal/${proposalId}`, plainManagerToken)).status, 403);
  assert.equal((await get(`/api/admin/active-staff?limit=100&shift_id=${futureShift}`, plainManagerToken)).status, 403);
});

test('events_worked is the same number the seniority route reports, filter by filter', async () => {
  const d = await get(`/api/shifts/detail/${futureShift}`, adminToken);
  for (const who of [near, far, bare, twice]) {
    const s = await get(`/api/admin/users/${who.id}/seniority`, adminToken);
    assert.equal(s.status, 200);
    assert.equal(d.body.requests.find((x) => x.user_id === who.id).events_worked, s.body.events_worked);
  }
});
```

Create `server/routes/drinkPlans.dayOfContact.test.js`:

```js
// GET /api/drink-plans/by-proposal/:proposalId?fields=day_of_contact
//
// The phone event detail shows the day-of contact and nothing else from the
// drink plan. This projection exists so that is ALL the phone reads, and all
// the admin service worker stores: the full read carries the plan's
// write-capable token, the internal notes and the venue access notes clients
// type gate codes into (lane ma-e2, security checkpoint, 2026-09-29).

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');

if (process.env.NODE_ENV === 'production') {
  throw new Error('drinkPlans.dayOfContact.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = (label) => `day-of-${NONCE}-${label}@example.com`;
const ids = { users: [], proposals: [], clients: [], plans: [] };
let server, baseUrl, adminToken, staffToken;
let withContact, withoutContact, blankName, noPlan;

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
async function makeUser(label, role) {
  const r = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', $2, 'approved', 0) RETURNING id, token_version`,
    [EMAIL(label), role]
  );
  ids.users.push(r.rows[0].id);
  return jwt.sign({ userId: r.rows[0].id, tokenVersion: r.rows[0].token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
async function seedProposal() {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, guest_count, event_type, total_price, amount_paid)
     VALUES ($1, 'deposit_paid', CURRENT_DATE + 30, 100, 'wedding-reception', 1000, 100) RETURNING id`,
    [ids.clients[0]]
  );
  ids.proposals.push(p.rows[0].id);
  return p.rows[0].id;
}
async function seedPlan(proposalId, selections) {
  const r = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, admin_notes, client_email)
     VALUES ($1, 'draft', $2::jsonb, 'internal: client is slow to pay', $3) RETURNING id`,
    [proposalId, JSON.stringify(selections), EMAIL('client')]
  );
  ids.plans.push(r.rows[0].id);
}

before(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/drink-plans', require('./drinkPlans'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    return res.status(500).json({ error: 'Internal error' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });

  adminToken = await makeUser('admin', 'admin');
  staffToken = await makeUser('staff', 'staff');
  const c = await pool.query(`INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550000') RETURNING id`,
    [`DayOf ${NONCE}`, EMAIL('client')]);
  ids.clients.push(c.rows[0].id);

  withContact = await seedProposal();
  withoutContact = await seedProposal();
  blankName = await seedProposal();
  noPlan = await seedProposal();
  await seedPlan(withContact, {
    logistics: {
      dayOfContact: { name: ' Marcus Keller ', phone: '(312) 555-0142' },
      accessNotes: 'gate code 4471, loading dock on the alley',
      parking: 'street',
    },
    menuStyle: 'house',
  });
  await seedPlan(withoutContact, { logistics: { accessNotes: 'side door' } });
  await seedPlan(blankName, { logistics: { dayOfContact: { name: '   ', phone: '3125550142' } } });
});

after(async () => {
  await pool.query('DELETE FROM drink_plans WHERE id = ANY($1::int[])', [ids.plans]);
  await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids.proposals]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [ids.clients]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids.users]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('the projection returns the name and the phone, and NOTHING else', async () => {
  const r = await get(`/api/drink-plans/by-proposal/${withContact}?fields=day_of_contact`, adminToken);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { day_of_contact: { name: 'Marcus Keller', phone: '(312) 555-0142' } });
  const wire = JSON.stringify(r.body);
  for (const secret of ['4471', 'loading dock', 'slow to pay', 'token', 'selections', EMAIL('client')]) {
    assert.equal(wire.includes(secret), false, `the projection leaked ${secret}`);
  }
});

test('a plan with no day-of contact, or a blank name, answers null', async () => {
  const a = await get(`/api/drink-plans/by-proposal/${withoutContact}?fields=day_of_contact`, adminToken);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, { day_of_contact: null });
  const b = await get(`/api/drink-plans/by-proposal/${blankName}?fields=day_of_contact`, adminToken);
  assert.deepEqual(b.body, { day_of_contact: null });
});

test('no drink plan is a 404, as on the full read', async () => {
  const r = await get(`/api/drink-plans/by-proposal/${noPlan}?fields=day_of_contact`, adminToken);
  assert.equal(r.status, 404);
  assert.equal((await get(`/api/drink-plans/by-proposal/${noPlan}`, adminToken)).status, 404);
});

test('an unknown projection and a malformed id are 400, never 500', async () => {
  assert.equal((await get(`/api/drink-plans/by-proposal/${withContact}?fields=all`, adminToken)).status, 400);
  assert.equal((await get(`/api/drink-plans/by-proposal/${withContact}?fields=`, adminToken)).status, 400);
  assert.equal((await get(`/api/drink-plans/by-proposal/${withContact}?fields=day_of_contact&fields=token`, adminToken)).status, 400);
  for (const bad of ['abc', '0', '1.5', '99999999999']) {
    assert.equal((await get(`/api/drink-plans/by-proposal/${bad}?fields=day_of_contact`, adminToken)).status, 400, bad);
  }
});

test('the full read is unchanged: the desktop still gets the whole plan', async () => {
  const r = await get(`/api/drink-plans/by-proposal/${withContact}`, adminToken);
  assert.equal(r.status, 200);
  for (const k of ['id', 'token', 'proposal_id', 'selections', 'status', 'admin_notes', 'has_shopping_list', 'extras_unpaid_cents']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r.body, k), `the full read lost ${k}`);
  }
  assert.equal(r.body.selections.logistics.accessNotes, 'gate code 4471, loading dock on the alley');
  assert.equal(Object.prototype.hasOwnProperty.call(r.body, 'day_of_contact'), false);
});

test('staff cannot read either form', async () => {
  assert.equal((await get(`/api/drink-plans/by-proposal/${withContact}?fields=day_of_contact`, staffToken)).status, 403);
  assert.equal((await get(`/api/drink-plans/by-proposal/${withContact}`, staffToken)).status, 403);
  assert.equal((await get(`/api/drink-plans/by-proposal/${withContact}?fields=day_of_contact`)).status, 401);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run, one at a time:

```bash
node --test server/routes/shifts.staffingMeta.test.js
node --test server/routes/drinkPlans.dayOfContact.test.js
```

Expected (reasoned from the code, NOT measured: these suites seed the shared dev database, so the plan fleet could not run them): the first reports 14 tests with 3 failing, "a malformed path id answers 400" (today it is a 500), "active-staff with shift_id adds events_worked and a WHOLE-mile distance" (today the distance has a decimal) and "wholeMiles rounds to the mile" (`wholeMiles` is not exported yet, so the require yields `undefined`); the other 11 pass, including the three new fixture tests, which describe behaviour Task 1 already has. The second reports 6 tests with 3 failing: the projection test, the null test and the 400 test. If your numbers differ, read why before changing any code, and report it.

- [ ] **Step 3: Whole miles for the picker**

Replace the whole of `server/utils/staffingMeta.js` with:

```js
'use strict';

// Seniority and proximity facts for the staffing surfaces (spec
// 2026-08-13-mobile-admin section 3, design-session decisions of 2026-09-15):
// how many events a person has worked and how far their home is from a venue,
// shown as plain meta beside an applicant or a picker candidate. Information
// only. Nothing here ranks, sorts or scores; autoAssign.js owns ranking and is
// not a caller.
//
// events_worked has ONE definition and this is its third reader. The other two
// are server/utils/autoAssign.js (step 3) and GET /admin/users/:id/seniority.
// All three count approved, not-dropped requests on shifts dated before the
// CHICAGO business day (never CURRENT_DATE, which is a GMT day and counts
// tonight's shift as worked from 19:00 Chicago), plus the pre-migration
// contractor_profiles.historical_events_worked. It counts SHIFTS: a staffer
// approved on two shifts of one event counts two, in all three readers.
// server/routes/shifts.staffingMeta.test.js pins this reader to the seniority
// route so the three cannot drift silently.
const { pool } = require('../db');
const { chicagoTodayYmd } = require('./businessTime');
const { milesBetween } = require('./serviceArea');

function cleanIds(userIds) {
  return [...new Set((userIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

// WHOLE miles, on purpose. The picker returns a distance for EVERY active
// staffer against ANY shift, and the phone stores what it reads. At a tenth of
// a mile, ten venues place a home within about two hundred feet; at a whole
// mile the same ten give about four tenths of a mile. Dallas staffs on
// proximity, not on a tenth of a mile. The two legacy reads keep roundMiles
// (a tenth) for requesters, as the desktop has always shown them.
function wholeMiles(miles) {
  if (miles === null || miles === undefined) return null;
  const n = Number(miles);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Map of user id -> events worked. A user with no profile and no shifts maps to 0. */
async function loadEventsWorked(userIds, db = pool) {
  const ids = cleanIds(userIds);
  if (ids.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT u.id AS user_id,
            COALESCE(cp.historical_events_worked, 0) + COALESCE(w.live, 0) AS events_worked
       FROM users u
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
       LEFT JOIN (
         SELECT sr.user_id, COUNT(*)::int AS live
           FROM shift_requests sr
           JOIN shifts s ON s.id = sr.shift_id
          WHERE sr.user_id = ANY($1::int[])
            AND sr.status = 'approved'
            AND sr.dropped_at IS NULL
            AND s.event_date < $2::date
          GROUP BY sr.user_id
       ) w ON w.user_id = u.id
      WHERE u.id = ANY($1::int[])`,
    [ids, chicagoTodayYmd()]
  );
  return new Map(rows.map((r) => [Number(r.user_id), Number(r.events_worked)]));
}

/**
 * Picker meta for one shift: for each user id, the events-worked count and the
 * distance, in whole miles, from that person's home to THIS shift's venue. The
 * raw home coordinates are read here and never returned. Null when the shift
 * does not exist, so the route can answer 404.
 */
async function candidateMeta(shiftId, userIds, db = pool) {
  const shiftRes = await db.query('SELECT id, lat, lng FROM shifts WHERE id = $1', [shiftId]);
  const shift = shiftRes.rows[0];
  if (!shift) return null;
  const ids = cleanIds(userIds);
  const out = new Map();
  if (ids.length === 0) return out;
  const [worked, homes] = await Promise.all([
    loadEventsWorked(ids, db),
    db.query('SELECT user_id, lat, lng FROM contractor_profiles WHERE user_id = ANY($1::int[])', [ids]),
  ]);
  const homeBy = new Map(homes.rows.map((h) => [Number(h.user_id), h]));
  for (const id of ids) {
    const home = homeBy.get(id);
    out.set(id, {
      events_worked: worked.get(id) ?? 0,
      home_distance_miles: home ? wholeMiles(milesBetween(home.lat, home.lng, shift.lat, shift.lng)) : null,
    });
  }
  return out;
}

module.exports = { loadEventsWorked, candidateMeta, wholeMiles };
```

- [ ] **Step 4: Validate the path id on the two shifts reads**

In `server/routes/shifts.js`, directly after the `clampInt` function (`:42-46`), add:

```js
// Path ids arrive from URLs, and the phone deep-links both reads below. A
// malformed id used to reach Postgres, raise, and answer a generic 500 with a
// Sentry event; on the phone that is an error screen whose Retry can never
// succeed. Digits only, and inside int4.
function requireId(raw, name) {
  const text = String(raw);
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 2147483647) {
    throw new ValidationError({ [name]: `${name} must be a positive integer.` });
  }
  return Number(text);
}
```

In `GET /by-proposal/:proposalId`, make the handler's first line:

```js
  const proposalId = requireId(req.params.proposalId, 'proposalId');
```

and change that handler's query parameters from `[req.params.proposalId]` to `[proposalId]`.

In `GET /detail/:id`, make the handler's first line:

```js
  const shiftId = requireId(req.params.id, 'id');
```

and change BOTH query parameter arrays inside that handler from `[req.params.id]` to `[shiftId]`. Other handlers in the file also read `req.params.id`; leave every one of them alone.

- [ ] **Step 5: The day-of-contact projection**

In `server/routes/drinkPlans.js`, in `GET /by-proposal/:proposalId` (`:381`), add this as the first thing inside the handler, before the existing query:

```js
  // Phone projection (lane ma-e2, security checkpoint 2026-09-29). The phone
  // event detail shows the day-of contact and nothing else from the plan, so
  // this is all it reads and all the admin service worker stores. The full
  // read below carries the plan's write-capable token, the internal notes and
  // the venue access notes clients type gate codes into.
  if (req.query.fields !== undefined) {
    if (req.query.fields !== 'day_of_contact') {
      throw new ValidationError({ fields: 'Unknown projection.' });
    }
    const rawId = String(req.params.proposalId);
    if (!/^\d+$/.test(rawId) || Number(rawId) < 1 || Number(rawId) > 2147483647) {
      throw new ValidationError({ proposalId: 'proposalId must be a positive integer.' });
    }
    const projected = await pool.query(
      `SELECT dp.selections->'logistics'->'dayOfContact' AS contact
         FROM drink_plans dp
        WHERE dp.proposal_id = $1`,
      [Number(rawId)]
    );
    if (!projected.rows[0]) throw new NotFoundError('No drink plan found for this proposal.');
    const contact = projected.rows[0].contact;
    const held = contact && typeof contact === 'object' ? contact : {};
    const name = String(held.name || '').trim();
    const phone = String(held.phone || '').trim();
    return res.json({ day_of_contact: name ? { name, phone } : null });
  }
```

`ValidationError` and `NotFoundError` are already imported (`:9`). Change nothing else in the file.

- [ ] **Step 6: Run the server tests green, then the neighbours**

```bash
TZ=UTC node --test server/routes/shifts.staffingMeta.test.js
TZ=America/Chicago node --test server/routes/shifts.staffingMeta.test.js
node --test server/routes/drinkPlans.dayOfContact.test.js
node --test server/routes/shifts.bonus.test.js
node --test server/routes/admin/users.activeStaff.test.js
node --test server/routes/drinkPlans.beo.test.js
node --test server/routes/drinkPlans.shoppingListStrip.test.js
```

Expected: `# pass 14` both times, `# pass 6`, then each neighbour at the pass count it has BEFORE your change (measure that first: run the four neighbours once before Step 3 and write the counts down).

- [ ] **Step 7: Commit the server half**

```bash
git add server/utils/staffingMeta.js server/routes/shifts.js server/routes/drinkPlans.js server/routes/shifts.staffingMeta.test.js server/routes/drinkPlans.dayOfContact.test.js && git commit -F - <<'MSG'
fix(staffing): checkpoint fold, the server half

The picker's distances are whole miles: they are stored on the phone for
every active staffer, and a tenth of a mile to ten venues places a home to
the block. The drink plan gains a day-of-contact projection, so the phone
reads a name and a number and never the plan's token, internal notes or
venue access notes. The two shifts reads answer 400 for a malformed id.
The staffing test gains the fixtures that pin every filter of the
events-worked definition.
MSG
```

- [ ] **Step 8: Replace and add the client tests**

Replace the whole of `client/src/utils/adminSwAllowlist.test.js` with:

```js
import '@testing-library/jest-dom';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

// admin-sw.js is a plain static script, not a module, so it cannot be
// imported. Its top level only declares constants and functions and registers
// listeners on `self`, so it loads in a vm context with a stub `self`, and a
// top-level const is then readable by evaluating its name in that context.
// This test runs the REAL file: it holds no copy of any pattern.
function loadServiceWorker() {
  const src = fs.readFileSync(path.resolve(__dirname, '../../public/admin-sw.js'), 'utf8');
  const listeners = {};
  const self = { addEventListener: (type, fn) => { listeners[type] = fn; }, location: { origin: 'https://admin.example.test' } };
  const context = vm.createContext({ self, caches: {}, fetch: () => Promise.reject(new Error('no network in test')), URL, Response: function Response() {}, Headers: function Headers() {}, console, setTimeout, clearTimeout });
  vm.runInContext(src, context);
  return {
    isAllowlisted: vm.runInContext('isAllowlisted', context),
    asksForOffline: vm.runInContext('asksForOffline', context),
    version: vm.runInContext('SW_VERSION', context),
    onFetch: listeners.fetch,
  };
}
const request = (headers = {}) => ({ headers: { get: (name) => (name.toLowerCase() in headers ? headers[name.toLowerCase()] : null) } });

describe('admin service worker read allowlist', () => {
  const { isAllowlisted, version } = loadServiceWorker();

  test.each([
    '/api/shifts',
    '/api/proposals',
    '/api/proposals/13',
    '/api/shifts/by-proposal/13',
    '/api/admin/badge-counts',
    '/api/admin/search',
    '/api/admin/active-staff',
    '/api/auth/me',
  ])('still caches %s', (p) => {
    expect(isAllowlisted(p)).toBe(true);
  });

  test.each([
    '/api/shifts/detail/17',
    '/api/invoices/proposal/13',
  ])('caches the event detail and sheet read %s', (p) => {
    expect(isAllowlisted(p)).toBe(true);
  });

  test('caches the drink plan only as its day-of-contact projection', () => {
    expect(isAllowlisted('/api/drink-plans/by-proposal/13', '?fields=day_of_contact')).toBe(true);
    // The full read carries the plan token, internal notes and venue access notes.
    expect(isAllowlisted('/api/drink-plans/by-proposal/13')).toBe(false);
    expect(isAllowlisted('/api/drink-plans/by-proposal/13', '')).toBe(false);
    expect(isAllowlisted('/api/drink-plans/by-proposal/13', '?fields=all')).toBe(false);
    expect(isAllowlisted('/api/drink-plans/by-proposal/13', '?fields=day_of_contact&x=1')).toBe(false);
    expect(isAllowlisted('/api/drink-plans/by-proposal/13', '?x=1&fields=day_of_contact')).toBe(false);
    expect(isAllowlisted('/api/drink-plans/by-proposal/13/consult', '?fields=day_of_contact')).toBe(false);
    expect(isAllowlisted('/api/drink-plans/13', '?fields=day_of_contact')).toBe(false);
  });

  test.each([
    '/api/shifts/detail/17/extra',
    '/api/shifts/detail/abc',
    '/api/shifts/detail/',
    '/api/shifts/detail/17/',
    '/api/shifts/17/requests',
    '/api/shifts/requests/9',
    '/api/shifts/by-proposal/13/extra',
    '/api/shifts/by-proposal/13%20',
    '/api/shifts/by-proposal/event-details',
    '/api/shifts/by-proposal/',
    '/api/drink-plans/13',
    '/api/drink-plans/by-proposal/13/consult',
    '/api/drink-plans/t/0b8f6d2e-1111-4222-8333-444455556666',
    '/api/invoices/13',
    '/api/invoices/proposal/13/extra',
    '/api/invoices/t/0b8f6d2e-1111-4222-8333-444455556666',
    '/api/invoices/client/0b8f6d2e-1111-4222-8333-444455556666',
    '/api/proposals/13/cancel-line/targets',
    '/api/proposals/t/0b8f6d2e-1111-4222-8333-444455556666',
    '/api/proposals/financials',
    '/api/stripe/refunds/13',
    '/api/admin/users/12',
    '/api/admin/users/12/seniority',
    '/api/admin/active-staff/extra',
  ])('never caches %s', (p) => {
    expect(isAllowlisted(p)).toBe(false);
    expect(isAllowlisted(p, '?fields=day_of_contact')).toBe(false);
  });

  test('the version was bumped so installed phones pick the new allowlist up', () => {
    expect(version).not.toBe('admin-sw-2026-08-14-v8');
    expect(version).toMatch(/^admin-sw-\d{4}-\d{2}-\d{2}-v9$/);
  });
});

describe('storing and stale-serving are opt-in', () => {
  const { asksForOffline, onFetch } = loadServiceWorker();

  test('a request asks with the header, and only with the value 1', () => {
    expect(asksForOffline(request({ 'x-offline-ok': '1' }), '/api/shifts/detail/17')).toBe(true);
    expect(asksForOffline(request(), '/api/shifts/detail/17')).toBe(false);
    expect(asksForOffline(request({ 'x-offline-ok': '0' }), '/api/shifts/detail/17')).toBe(false);
    expect(asksForOffline(request({ 'x-offline-ok': 'true' }), '/api/shifts/detail/17')).toBe(false);
    expect(asksForOffline(request({ 'x-offline-ok': '' }), '/api/invoices/proposal/13')).toBe(false);
  });

  test('the identity read is served to every surface, header or not', () => {
    expect(asksForOffline(request(), '/api/auth/me')).toBe(true);
    expect(asksForOffline(request(), '/api/auth/me/extra')).toBe(false);
  });

  // The fetch handler itself, with a fake event: respondWith is the ONLY way
  // the worker can store or answer a request, so "never called" is the proof.
  const fire = (url, { method = 'GET', headers = {}, mode = 'cors' } = {}) => {
    const event = {
      request: { url, method, mode, headers: request(headers).headers, clone() { return this; } },
      respondWith: jest.fn((p) => { Promise.resolve(p).catch(() => {}); }),
      waitUntil: jest.fn(),
    };
    onFetch(event);
    return event;
  };

  test.each([
    'https://api.example.test/api/shifts/detail/17',
    'https://api.example.test/api/invoices/proposal/13',
    'https://api.example.test/api/proposals/13',
    'https://api.example.test/api/shifts/by-proposal/13',
    'https://api.example.test/api/admin/active-staff?limit=100',
    'https://api.example.test/api/drink-plans/by-proposal/13?fields=day_of_contact',
  ])('a desktop read of %s, which sends no header, is left to the network', (url) => {
    expect(fire(url).respondWith).not.toHaveBeenCalled();
  });

  test.each([
    'https://api.example.test/api/shifts/detail/17',
    'https://api.example.test/api/invoices/proposal/13',
    'https://api.example.test/api/drink-plans/by-proposal/13?fields=day_of_contact',
    'https://api.example.test/api/admin/active-staff?limit=100&shift_id=17',
  ])('a phone read of %s, which sends the header, is handled', (url) => {
    expect(fire(url, { headers: { 'x-offline-ok': '1' } }).respondWith).toHaveBeenCalledTimes(1);
  });

  test('the header cannot widen the allowlist', () => {
    for (const url of [
      'https://api.example.test/api/drink-plans/by-proposal/13',
      'https://api.example.test/api/invoices/t/0b8f6d2e-1111-4222-8333-444455556666',
      'https://api.example.test/api/admin/users/12',
      'https://api.example.test/api/payroll/periods',
    ]) expect(fire(url, { headers: { 'x-offline-ok': '1' } }).respondWith).not.toHaveBeenCalled();
  });

  test('a write is never intercepted, header or not', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(fire('https://api.example.test/api/invoices/proposal/13', { method, headers: { 'x-offline-ok': '1' } }).respondWith).not.toHaveBeenCalled();
      expect(fire('https://api.example.test/api/shifts/17/assign', { method, headers: { 'x-offline-ok': '1' } }).respondWith).not.toHaveBeenCalled();
    }
  });
});
```

Create `client/src/utils/offlineRead.test.js`:

```js
import '@testing-library/jest-dom';
import { offlineGet, OFFLINE_OK_HEADER } from './offlineRead';
import api from './api';

jest.mock('./api', () => ({ __esModule: true, default: { get: jest.fn() } }));

beforeEach(() => { api.get.mockResolvedValue({ data: { ok: true }, staleAt: '2026-09-29T17:00:00.000Z' }); });

test('adds the opt-in header and passes the response through untouched', async () => {
  const res = await offlineGet('/shifts/detail/17');
  expect(api.get).toHaveBeenCalledWith('/shifts/detail/17', { headers: { 'X-Offline-Ok': '1' } });
  expect(res).toEqual({ data: { ok: true }, staleAt: '2026-09-29T17:00:00.000Z' });
  expect(OFFLINE_OK_HEADER).toBe('X-Offline-Ok');
});

test('keeps the params and any other header the caller passed', async () => {
  await offlineGet('/shifts', { params: { scope: 'past' }, headers: { 'X-Other': 'a' } });
  expect(api.get).toHaveBeenCalledWith('/shifts', {
    params: { scope: 'past' },
    headers: { 'X-Other': 'a', 'X-Offline-Ok': '1' },
  });
});

test('never mutates the config it was given', async () => {
  const config = { params: { scope: 'past' } };
  await offlineGet('/shifts', config);
  expect(config).toEqual({ params: { scope: 'past' } });
});

test('a rejection passes through', async () => {
  api.get.mockRejectedValue({ status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' });
  await expect(offlineGet('/shifts')).rejects.toEqual({ status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' });
});
```

Replace the whole of `client/src/hooks/useDrawerParam.test.js` with:

```js
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import useDrawerParam from './useDrawerParam';

// Back is navigate(-1): the same history pop Android's hardware Back fires.
function Probe({ push }) {
  const drawer = useDrawerParam(push ? { push: true, kinds: ['shift'] } : undefined);
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <div data-testid="loc">{location.pathname + location.search}</div>
      <div data-testid="kind">{drawer.kind || 'none'}</div>
      <div data-testid="id">{drawer.id || 'none'}</div>
      <div data-testid="focus">{drawer.focus || 'none'}</div>
      <button type="button" onClick={() => drawer.open('shift', 17)}>open</button>
      <button type="button" onClick={() => drawer.open('shift', 17, { focus: 42 })}>open-focused</button>
      <button type="button" onClick={() => drawer.open('invoices', 13)}>open-invoices</button>
      <button type="button" onClick={() => drawer.close()}>close</button>
      <button type="button" onClick={() => navigate(-1)}>back</button>
    </div>
  );
}
function Before() { return <div data-testid="loc">/before</div>; }

function mount({ push, entries = ['/before', '/events?scope=past'], index = entries.length - 1 }) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      <Routes>
        <Route path="/before" element={<Before />} />
        <Route path="/events" element={<Probe push={push} />} />
      </Routes>
    </MemoryRouter>
  );
}
const loc = () => screen.getByTestId('loc').textContent;
const tap = (name) => fireEvent.click(screen.getByRole('button', { name }));

test('the default keeps replace semantics: Back after open leaves the page', async () => {
  mount({ push: false });
  tap('open');
  await waitFor(() => expect(loc()).toBe('/events?scope=past&drawer=shift&drawerId=17'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('push mode: Back closes the sheet and stays on the page', async () => {
  mount({ push: true });
  tap('open');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  expect(screen.getByTestId('id')).toHaveTextContent('17');
  tap('back');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  expect(screen.getByTestId('kind')).toHaveTextContent('none');
});

test('push mode: close() pops the entry it pushed, so no entry piles up', async () => {
  mount({ push: true });
  tap('open');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  tap('close');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('push mode: opening, closing and opening again still leaves one entry behind the sheet', async () => {
  mount({ push: true });
  tap('open');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  tap('close');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('none'));
  tap('open');
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('a deep-linked sheet gets an entry seeded behind it', async () => {
  mount({ push: true, entries: ['/before', '/events?scope=past&drawer=shift&drawerId=17'] });
  expect(screen.getByTestId('kind')).toHaveTextContent('shift');
  await waitFor(() => expect(loc()).toBe('/events?scope=past&drawer=shift&drawerId=17'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  expect(screen.getByTestId('kind')).toHaveTextContent('none');
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('a deep-linked sheet closed with close() lands on the bare page, one Back from where it came', async () => {
  mount({ push: true, entries: ['/before', '/events?drawer=shift&drawerId=17'] });
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  tap('close');
  await waitFor(() => expect(loc()).toBe('/events'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('the default never seeds: a deep-linked desktop drawer keeps its single entry', async () => {
  mount({ push: false, entries: ['/before', '/events?drawer=shift&drawerId=17'] });
  expect(screen.getByTestId('kind')).toHaveTextContent('shift');
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('focus rides the URL and clears with the sheet', async () => {
  mount({ push: true });
  tap('open-focused');
  await waitFor(() => expect(screen.getByTestId('focus')).toHaveTextContent('42'));
  expect(loc()).toBe('/events?scope=past&drawer=shift&drawerId=17&drawerFocus=42');
  tap('close');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  expect(screen.getByTestId('focus')).toHaveTextContent('none');
});

test('opening without a focus drops a focus left over from an earlier open', async () => {
  mount({ push: false, entries: ['/events?drawer=shift&drawerId=9&drawerFocus=42'] });
  tap('open');
  await waitFor(() => expect(loc()).toBe('/events?drawer=shift&drawerId=17'));
});

test('a kind that is not a sheet keeps replace semantics and is never seeded, even in push mode', async () => {
  mount({ push: true });
  tap('open-invoices');
  await waitFor(() => expect(loc()).toBe('/events?scope=past&drawer=invoices&drawerId=13'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('a deep link to a kind that is not a sheet gains no history entry', async () => {
  mount({ push: true, entries: ['/before', '/events?drawer=invoices&drawerId=13'] });
  expect(screen.getByTestId('kind')).toHaveTextContent('invoices');
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('a malformed sheet id seeds nothing: no entry for a sheet that will never mount', async () => {
  mount({ push: true, entries: ['/before', '/events?drawer=shift&drawerId=abc'] });
  expect(screen.getByTestId('id')).toHaveTextContent('abc');
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('under StrictMode the seed still runs once', async () => {
  render(
    <React.StrictMode>
      <MemoryRouter initialEntries={['/before', '/events?scope=past&drawer=shift&drawerId=17']} initialIndex={1}>
        <Routes>
          <Route path="/before" element={<Before />} />
          <Route path="/events" element={<Probe push />} />
        </Routes>
      </MemoryRouter>
    </React.StrictMode>
  );
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

test('the default close replaces, and keeps every other query param', async () => {
  mount({ push: false, entries: ['/before', '/events?scope=past&drawer=shift&drawerId=17'] });
  tap('close');
  await waitFor(() => expect(loc()).toBe('/events?scope=past'));
  tap('back');
  await waitFor(() => expect(loc()).toBe('/before'));
});

describe('against the real browser history', () => {
  afterEach(() => { window.history.replaceState(null, '', '/'); });

  test('an entry that claims it was pushed but has nothing behind it still closes', async () => {
    // What a duplicated tab or a trimmed history leaves: the flag, at index 0.
    window.history.replaceState({ usr: { mSheet: true }, key: 'orphan', idx: 0 }, '', '/events?scope=past&drawer=shift&drawerId=17');
    render(
      <BrowserRouter>
        <Routes><Route path="/events" element={<Probe push />} /></Routes>
      </BrowserRouter>
    );
    expect(screen.getByTestId('kind')).toHaveTextContent('shift');
    tap('close');
    await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('none'));
    expect(window.location.pathname + window.location.search).toBe('/events?scope=past');
  });

  test('open pushes exactly one entry and close pops it', async () => {
    window.history.replaceState(null, '', '/events?scope=past');
    render(
      <BrowserRouter>
        <Routes><Route path="/events" element={<Probe push />} /></Routes>
      </BrowserRouter>
    );
    const before = window.history.length;
    const at = window.history.state.idx;
    tap('open');
    await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('shift'));
    expect(window.history.length).toBe(before + 1);
    expect(window.history.state.idx).toBe(at + 1);
    tap('close');
    await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('none'));
    expect(window.location.pathname + window.location.search).toBe('/events?scope=past');
    // Popped, not replaced: a replace would leave the position where open put it.
    expect(window.history.state.idx).toBe(at);
  });
});
```

- [ ] **Step 9: Run them to verify they fail**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/adminSwAllowlist.test.js src/utils/offlineRead.test.js src/hooks/useDrawerParam.test.js`
Expected (measured against the lane as Tasks 2 and 3 left it, in a scratch copy, 2026-09-29): `adminSwAllowlist.test.js` fails to run, `ReferenceError: asksForOffline is not defined`; `offlineRead.test.js` fails to run, `Cannot find module './offlineRead'`; `useDrawerParam.test.js` reports 16 tests, 1 failed: "a malformed sheet id seeds nothing". The other fifteen pass and must keep passing.

- [ ] **Step 10: The opt-in read helper**

Create `client/src/utils/offlineRead.js`:

```js
import api from './api';

// A read that may be answered from the phone's cache (spec
// 2026-08-13-mobile-admin section 7).
//
// The admin service worker stores a response, and serves the stored copy when
// the network fails or stalls, ONLY for a request that carries this header.
// The header is a promise the caller makes: "I render the staleness line, and
// I do not act on a cache-served copy." A screen that cannot keep that promise
// must use api.get and get the network or an error, never old data dressed as
// new. That is every desktop screen, and every write-adjacent re-read.
//
// The response carries res.staleAt when the service worker served it.
export const OFFLINE_OK_HEADER = 'X-Offline-Ok';

export function offlineGet(url, config = {}) {
  return api.get(url, {
    ...config,
    headers: { ...(config.headers || {}), [OFFLINE_OK_HEADER]: '1' },
  });
}
```

- [ ] **Step 11: The service worker: opt-in, anchored, projection only**

In `client/public/admin-sw.js`, replace the whole `isAllowlisted` definition (it begins `const isAllowlisted = (pathname) =>` at `:194` and ends with the line `/^\/api\/invoices\/proposal\/\d+$/.test(pathname);` at `:205`) with:

```js
const isAllowlisted = (pathname, search = '') =>
  API_EXACT.has(pathname) ||
  /^\/api\/proposals\/\d+$/.test(pathname) ||
  /^\/api\/shifts\/by-proposal\/\d+$/.test(pathname) ||
  // Phone event detail and assignment sheet (lane ma-e2). Anchored on both
  // ends and numeric-id only, so no token route and no sub-resource can ride
  // in. The invoices read is cached on purpose: it carries the bank debit in
  // flight, and an offline detail showing a plain balance while a debit is
  // settling is how a client gets chased for money already on its way.
  /^\/api\/shifts\/detail\/\d+$/.test(pathname) ||
  /^\/api\/invoices\/proposal\/\d+$/.test(pathname) ||
  // The drink plan is stored ONLY as its day-of-contact projection (a name
  // and a phone). The full read carries the plan's write-capable token, the
  // internal notes and the venue access notes clients type gate codes into;
  // none of that belongs at rest on a phone that needs two fields.
  (/^\/api\/drink-plans\/by-proposal\/\d+$/.test(pathname) && search === '?fields=day_of_contact');

// Storing and stale-serving are OPT-IN, per request. This worker controls
// every page on the admin origin, desktop included, and only the phone screens
// render the staleness line. A desktop roster under an Approve button, or an
// invoice list under Send and Void, must never be yesterday's copy dressed as
// today's. So a read enters the cache, and is answered from it, only when the
// caller sent this header (client/src/utils/offlineRead.js). Everything else
// on an allowlisted path goes to the network untouched and is never stored.
// The identity read is the one exception: AuthContext bounds a cache-served
// identity by the token's own expiry, for every surface.
const OFFLINE_HEADER = 'x-offline-ok';
const IDENTITY_PATH = '/api/auth/me';
const asksForOffline = (req, pathname) =>
  pathname === IDENTITY_PATH || req.headers.get(OFFLINE_HEADER) === '1';
```

and replace the API branch's condition (`:296`), which reads `if (url.pathname.startsWith('/api/') && isAllowlisted(url.pathname)) {`, with:

```js
  if (url.pathname.startsWith('/api/') && isAllowlisted(url.pathname, url.search) && asksForOffline(req, url.pathname)) {
```

Leave `SW_VERSION` at `admin-sw-2026-09-29-v9`: v9 has not shipped, so there is nothing to bump past. Change nothing else in the file.

- [ ] **Step 12: The hook seeds only for a numeric sheet id**

Replace the whole of `client/src/hooks/useDrawerParam.js` with:

```js
import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

// location.state flag on a history entry this hook pushed. close() reads it to
// know whether going back one entry is safe.
const SHEET_STATE = 'mSheet';
const KEYS = ['drawer', 'drawerId', 'drawerFocus'];

function withoutDrawer(params) {
  const next = new URLSearchParams(params);
  KEYS.forEach((k) => next.delete(k));
  return next;
}

// Is there an entry behind this one? BrowserRouter keeps its position in
// window.history.state.idx. Where that is unknown (MemoryRouter in tests) the
// answer is yes, because the flag on the entry is then the only evidence.
function canGoBack() {
  const state = typeof window !== 'undefined' && window.history ? window.history.state : null;
  if (!state || typeof state.idx !== 'number') return true;
  return state.idx > 0;
}

/**
 * URL-synced drawer state. Reads/writes `?drawer=<kind>&drawerId=<id>` and the
 * optional `&drawerFocus=<id>`. Layered on top of whatever other query params
 * the page uses, never touching them.
 *
 * Usage:
 *   const drawer = useDrawerParam();
 *   drawer.kind  === 'event' when a drawer is open
 *   drawer.id    === '<id>' when a drawer is open
 *   drawer.open('event', e.id)
 *   drawer.close()
 *
 * Two history behaviours:
 *
 * DEFAULT (every desktop caller): open and close REPLACE the current entry. A
 * drawer is page state, not a navigation. Pushing made every open and every
 * close stack a history entry, so the Back button walked through drawer-toggle
 * states (re-opening drawers in a loop) instead of returning to the previous
 * page. Keep both `replace: true`.
 *
 * `{ push: true, kinds: ['shift'] }` (phone bottom sheets, spec
 * 2026-08-13-mobile-admin section 3): for the listed kinds, open PUSHES one
 * entry, so Android's hardware Back closes the sheet and stays on the page.
 * close() pops that same entry, so opening and closing a sheet any number of
 * times leaves history exactly as it found it. A sheet that arrives by deep
 * link or cold route restore has no entry behind it, so one is seeded: the
 * current entry is replaced by the bare page and the sheet is pushed on top.
 * A kind that is not listed keeps the default, so a desktop drawer link opened
 * on the phone never gains an entry for a sheet that does not exist. Omitting
 * `kinds` pushes for every kind.
 */
export default function useDrawerParam({ push = false, kinds = null } = {}) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const kind = params.get('drawer');
  const id = params.get('drawerId');
  const focus = params.get('drawerFocus');
  const pushed = !!(location.state && location.state[SHEET_STATE]);
  // A string, so an inline array from the caller cannot churn the callbacks.
  const kindList = Array.isArray(kinds) ? kinds.join(',') : null;
  const pushes = useCallback(
    (k) => push && (kindList === null || kindList.split(',').includes(k)),
    [push, kindList]
  );

  const open = useCallback((newKind, newId, { focus: newFocus } = {}) => {
    const next = new URLSearchParams(params);
    next.set('drawer', newKind);
    next.set('drawerId', String(newId));
    if (newFocus === undefined || newFocus === null) next.delete('drawerFocus');
    else next.set('drawerFocus', String(newFocus));
    if (pushes(newKind)) setParams(next, { state: { [SHEET_STATE]: true } });
    else setParams(next, { replace: true });
  }, [params, setParams, pushes]);

  const close = useCallback(() => {
    // Pop only an entry this hook pushed AND that has something behind it. An
    // entry that carries the flag with nothing behind it (a duplicated tab, a
    // history the browser trimmed) would otherwise never close.
    if (pushed && pushes(kind) && canGoBack()) { navigate(-1); return; }
    setParams(withoutDrawer(params), { replace: true });
  }, [params, setParams, pushes, pushed, kind, navigate]);

  // Seed an entry behind a sheet that has none. The ref latch is what makes
  // this safe under StrictMode, which runs an effect twice with the same
  // closure: the second run sees the same location.key and stops.
  const seededFor = useRef(null);
  useEffect(() => {
    // Digits only: every sheet is addressed by a numeric id, and the owners
    // mount a sheet only for one. A malformed id gets no entry seeded for a
    // sheet that will never show.
    if (!kind || !id || !/^\d+$/.test(id) || pushed || !pushes(kind)) return;
    if (seededFor.current === location.key) return;
    seededFor.current = location.key;
    const bare = withoutDrawer(params).toString();
    navigate({ pathname: location.pathname, search: bare ? `?${bare}` : '' }, { replace: true });
    navigate({ pathname: location.pathname, search: location.search }, { state: { [SHEET_STATE]: true } });
    // params is derived from location.search, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushes, kind, id, pushed, location.key, location.pathname, location.search, navigate]);

  return { kind, id, focus, open, close };
}

// Builds a same-page href that opens a drawer, preserving all other query
// params. For real links (cmd-click new tab) instead of onClick drawer.open.
export function drawerHref(searchParams, kind, id) {
  const next = new URLSearchParams(searchParams);
  next.set('drawer', kind);
  next.set('drawerId', String(id));
  return `?${next.toString()}`;
}
```

- [ ] **Step 13: Run the client tests green, then the neighbours, then the build**

```bash
cd client && CI=true npx react-scripts test --watchAll=false src/utils/adminSwAllowlist.test.js src/utils/offlineRead.test.js src/hooks/useDrawerParam.test.js src/utils/adminSw.purge.test.js src/pages/mobile/EventsListPhone.test.js src/pages/admin/EventsDashboard.fork.test.js src/context && CI=true npx react-scripts build
```

Expected: `adminSwAllowlist.test.js` 50 tests, `offlineRead.test.js` 4, `useDrawerParam.test.js` 16, all passing; the neighbours unchanged; no "not wrapped in act(...)" warning; the build exits 0.

One thing this step does NOT fix, on purpose: the phone Events list (lane ma-e1) still reads with `api.get`, so between this task and Task 9 it has no offline mode in the lane. Task 9 switches it to `offlineGet`. Its unit tests mock the api client and do not notice.

- [ ] **Step 14: Commit the client half**

```bash
git add client/public/admin-sw.js client/src/utils/offlineRead.js client/src/utils/offlineRead.test.js client/src/utils/adminSwAllowlist.test.js client/src/hooks/useDrawerParam.js client/src/hooks/useDrawerParam.test.js && git commit -F - <<'MSG'
fix(admin-sw): checkpoint fold, cached reads are opt-in per request

The worker controls every page on the admin origin, desktop included, and
only the phone screens render the staleness line. It now stores a read, and
answers from the store, only for a request that carries X-Offline-Ok, so a
desktop roster or invoice list is never an old copy shown as new. The
identity read keeps its behaviour. The drink plan is cached only as its
day-of-contact projection, and the by-proposal entry is anchored. The
history hook seeds an entry only for a numeric sheet id.
MSG
```

---

### Task 4: Pure staffing logic: roster rows, open roles, the role step

**Files:**
- Create: `client/src/utils/staffingSheet.js`
- Test: `client/src/utils/staffingSheet.test.js`

**Interfaces:**
- Consumes (the server contract is Task 1 as amended by Task 3b): from `client/src/utils/staffingRoles.js`: `parsePositionsNeeded(raw) -> string[]`, `rosterCounts(roles) -> { [role]: n }`, `computeRemaining(roster, approvedByRole) -> { [role]: n }`, `classifyRequest(rankedRoles, remaining) -> { state: 'actionable' | 'waitlisted', resolvableRole }`, `canonicalizeRole(v) -> string | null`. From `client/src/components/adminos/shifts.js`: `neededCount(roster) -> number`, `isCancelledEvent(e) -> boolean`. The request shapes produced by Task 1.
- Produces, for Tasks 6 and 8:
  - `initialsOf(name) -> string`
  - `staffMeta({ eventsWorked, miles }) -> string` ("14 events · 7 mi": WHOLE miles always, either part omitted when unknown, `''` when both are)
  - `normalizeRequest(raw) -> { requestId, userId, name, status, position, dropped, rankedRoles, miles, eventsWorked }` (accepts a `detail` request row or a `by-proposal` requester)
  - `buildShiftView(shift, rawRequests, { justAssigned = [] } = {}) -> ShiftView` where `ShiftView = { shiftId, rosterless, closedReason: 'cancelled' | 'past' | null, slots, filled, open, full, count, openRoles: [{ role, open }], openLabel, mix, rolesLabel, pills: ('filled' | 'pending' | 'open')[], rows: Row[] }` and `Row = { key, kind: 'rostered' | 'applicant' | 'waitlisted', requestId, userId, name, initials, position, rankedRoles, resolvableRole, meta }`
  - `roleStep(view, row) -> { kind: 'blocked' } | { kind: 'direct', role } | { kind: 'pick', roles: [{ role, open }] }`; `row.kind` may also be `'candidate'`
  - `candidatesOf(staff, view, query) -> Candidate[]` where `Candidate = { key, kind: 'candidate', userId, name, initials, meta }`
  - `confirmCopy(kind: 'remove' | 'deny', name) -> { copy, label }`
  - `READ_ONLY_NOTE = { cancelled, past, rosterless }` (the three read-only lines)

- [ ] **Step 1: Write the failing test**

Create `client/src/utils/staffingSheet.test.js`:

```js
import '@testing-library/jest-dom';
import {
  initialsOf, staffMeta, normalizeRequest, buildShiftView, roleStep, candidatesOf, confirmCopy, READ_ONLY_NOTE,
} from './staffingSheet';

const shift = (over = {}) => ({
  id: 17, status: 'open', proposal_status: 'deposit_paid', finished: false,
  positions_needed: '["Bartender","Bartender","Bartender"]', ...over,
});
// A detail-shaped request row (sr.* plus staff_name).
const req = (id, over = {}) => ({
  id, user_id: 100 + id, staff_name: `Person ${id}`, status: 'pending', position: null, dropped_at: null,
  requested_positions: '["Bartender"]', home_distance_miles: 6.8, events_worked: 14, ...over,
});
const approved = (id, role = 'Bartender', over = {}) => req(id, { status: 'approved', position: role, ...over });

describe('staffMeta', () => {
  test('both facts', () => {
    expect(staffMeta({ eventsWorked: 14, miles: 6.8 })).toBe('14 events · 7 mi');
  });
  test('staffMeta omits what is missing', () => {
    expect(staffMeta({ eventsWorked: 14, miles: null })).toBe('14 events');
    expect(staffMeta({ eventsWorked: null, miles: 2 })).toBe('2 mi');
    expect(staffMeta({ eventsWorked: 14, miles: undefined })).toBe('14 events');
    expect(staffMeta({ eventsWorked: 14, miles: '' })).toBe('14 events');
    expect(staffMeta({ eventsWorked: 14, miles: 'far' })).toBe('14 events');
    expect(staffMeta({ eventsWorked: undefined, miles: undefined })).toBe('');
    expect(staffMeta({})).toBe('');
    expect(staffMeta()).toBe('');
  });
  test('zero is a fact, one is singular, zero miles is a distance', () => {
    expect(staffMeta({ eventsWorked: 0, miles: null })).toBe('0 events');
    expect(staffMeta({ eventsWorked: 1, miles: null })).toBe('1 event');
    expect(staffMeta({ eventsWorked: 3, miles: 0 })).toBe('3 events · 0 mi');
    // Whole miles, always: a tenth of a mile to ten venues places a home to the block.
    expect(staffMeta({ eventsWorked: 3, miles: 6.44 })).toBe('3 events · 6 mi');
    expect(staffMeta({ eventsWorked: 3, miles: 0.3 })).toBe('3 events · 0 mi');
  });
});

test('initialsOf takes two letters and survives an empty name', () => {
  expect(initialsOf('Lena Park')).toBe('LP');
  expect(initialsOf('  mara  de la reyes ')).toBe('MD');
  expect(initialsOf('Sam')).toBe('S');
  expect(initialsOf('')).toBe('?');
  expect(initialsOf(null)).toBe('?');
});

test('normalizeRequest reads a detail row and a by-proposal requester alike', () => {
  const a = normalizeRequest(req(3));
  const b = normalizeRequest({ request_id: 3, user_id: 103, name: 'Person 3', status: 'pending', position: null,
    dropped_at: null, requested_positions: ['Bartender'], home_distance_miles: 6.8, events_worked: 14 });
  expect(a).toEqual(b);
  expect(a).toEqual({ requestId: 3, userId: 103, name: 'Person 3', status: 'pending', position: null,
    dropped: false, rankedRoles: ['Bartender'], miles: 6.8, eventsWorked: 14 });
});

describe('buildShiftView', () => {
  test('two of three filled, one applicant for the open slot', () => {
    const v = buildShiftView(shift(), [approved(2, 'Bartender', { staff_name: 'Sam Ortiz' }), approved(1, 'Bartender', { staff_name: 'Lena Park' }), req(3)]);
    expect(v).toMatchObject({ shiftId: 17, slots: 3, filled: 2, open: 1, full: false, count: '2/3', rosterless: false, closedReason: null });
    expect(v.openRoles).toEqual([{ role: 'Bartender', open: 1 }]);
    expect(v.openLabel).toBe('Bartender × 1');
    expect(v.mix).toBe('Bartender 2/3');
    expect(v.rolesLabel).toBe('Bartenders');
    expect(v.pills).toEqual(['filled', 'filled', 'pending']);
    expect(v.rows.map((r) => [r.name, r.kind])).toEqual([['Lena Park', 'rostered'], ['Sam Ortiz', 'rostered'], ['Person 3', 'applicant']]);
    expect(v.rows[0].meta).toBe('Bartender');
    expect(v.rows[2].meta).toBe('Bartender · 14 events · 7 mi');
    expect(v.rows[2].resolvableRole).toBe('Bartender');
  });

  test('a rostered person who was just assigned says so', () => {
    const v = buildShiftView(shift(), [approved(1)], { justAssigned: [101] });
    expect(v.rows[0].meta).toBe('Bartender · just assigned');
  });

  test('an approved request with dropped_at set is NOT on the roster and does not fill a slot', () => {
    const v = buildShiftView(shift(), [approved(1), approved(2, 'Bartender', { dropped_at: '2026-09-01T00:00:00Z' })]);
    expect(v.filled).toBe(1);
    expect(v.open).toBe(2);
    expect(v.rows.map((r) => r.requestId)).toEqual([1]);
  });

  test('an approval with no role on file still fills a slot, so the phone never offers it again', () => {
    const s = shift({ positions_needed: '["Bartender","Bartender"]' });
    const v = buildShiftView(s, [approved(1, 'Bartender'), approved(2, null)]);
    expect(v).toMatchObject({ slots: 2, filled: 2, open: 0, full: true, count: '2/2', mix: 'Bartender 2/2' });
    expect(v.openRoles).toEqual([]);
    expect(v.rows.map((r) => [r.requestId, r.meta])).toEqual([[1, 'Bartender'], [2, 'Staff']]);
    // Two roles: the unplaced approval takes the first one with room.
    const two = buildShiftView(shift({ positions_needed: '["Bartender","Barback"]' }), [approved(1, 'Bartender'), approved(2, 'not a role')]);
    expect(two.openRoles).toEqual([]);
    expect(two.mix).toBe('Bartender 1/1 · Barback 1/1');
  });

  test('an approved role the roster never declared does not fill a declared slot (desktop parity)', () => {
    const v = buildShiftView(shift({ positions_needed: '["Bartender","Bartender"]' }), [approved(1, 'Barback')]);
    expect(v).toMatchObject({ filled: 0, open: 2, count: '0/2' });
    expect(v.rows[0].meta).toBe('Barback');
  });

  test('a denied request is not a row', () => {
    const v = buildShiftView(shift(), [req(1, { status: 'denied' }), req(2)]);
    expect(v.rows.map((r) => r.requestId)).toEqual([2]);
  });

  test('an applicant whose ranked roles are all full is waitlisted, after the actionable ones', () => {
    const s = shift({ positions_needed: '["Bartender","Barback"]' });
    const v = buildShiftView(s, [
      approved(1, 'Bartender'),
      req(2, { requested_positions: '["Bartender"]' }),
      req(3, { requested_positions: '["Barback","Bartender"]' }),
    ]);
    expect(v.openRoles).toEqual([{ role: 'Barback', open: 1 }]);
    expect(v.mix).toBe('Bartender 1/1 · Barback 0/1');
    expect(v.rolesLabel).toBe('Bartenders + Barbacks');
    expect(v.rows.map((r) => [r.requestId, r.kind])).toEqual([[1, 'rostered'], [3, 'applicant'], [2, 'waitlisted']]);
    expect(v.rows[1].meta).toBe('Barback › Bartender · 14 events · 7 mi');
    expect(v.pills).toEqual(['filled', 'pending']);
  });

  test('an empty or unparseable ranked list reads "Any role" and classifies like the desktop', () => {
    const v = buildShiftView(shift(), [req(1, { requested_positions: '[]' }), req(2, { requested_positions: 'not json' }), req(3, { requested_positions: null })]);
    v.rows.forEach((r) => {
      expect(r.kind).toBe('applicant');
      expect(r.resolvableRole).toBe('Bartender');
      expect(r.meta).toBe('Any role · 14 events · 7 mi');
    });
  });

  test('an over-filled role never yields a negative open count or a fraction above the slots', () => {
    const s = shift({ positions_needed: '["Bartender","Bartender"]' });
    const v = buildShiftView(s, [approved(1), approved(2), approved(3)]);
    expect(v).toMatchObject({ slots: 2, filled: 2, open: 0, full: true, count: '2/2' });
    expect(v.openRoles).toEqual([]);
  });

  test('the legacy object-shaped roster expands to its count', () => {
    const v = buildShiftView(shift({ positions_needed: '[{"position":"bartender","count":2}]' }), []);
    expect(v).toMatchObject({ slots: 2, open: 2, count: '0/2' });
    expect(v.openRoles).toEqual([{ role: 'Bartender', open: 2 }]);
  });

  test('a shift with no declared roles is rosterless: one slot by law, nothing approvable', () => {
    const v = buildShiftView(shift({ positions_needed: '[]' }), [req(1)]);
    expect(v).toMatchObject({ rosterless: true, slots: 1, filled: 0, open: 1, count: '0/1', mix: '', rolesLabel: 'Staff' });
    expect(v.openRoles).toEqual([]);
    expect(v.rows[0].kind).toBe('waitlisted');
    expect(roleStep(v, v.rows[0])).toEqual({ kind: 'blocked' });
  });

  test('closedReason: finished is past; a cancelled shift or an archived proposal is cancelled and wins', () => {
    expect(buildShiftView(shift({ finished: true }), []).closedReason).toBe('past');
    expect(buildShiftView(shift({ status: 'cancelled' }), []).closedReason).toBe('cancelled');
    expect(buildShiftView(shift({ proposal_status: 'archived' }), []).closedReason).toBe('cancelled');
    expect(buildShiftView(shift({ status: 'cancelled', finished: true }), []).closedReason).toBe('cancelled');
  });

  test('null inputs do not throw', () => {
    expect(buildShiftView(null, null)).toMatchObject({ rosterless: true, rows: [], slots: 1 });
  });
});

describe('roleStep: the role that will be written is always one the screen showed', () => {
  const twoRoles = shift({ positions_needed: '["Bartender","Barback"]' });

  test('nothing open blocks everyone', () => {
    const v = buildShiftView(shift({ positions_needed: '["Bartender"]' }), [approved(1), req(2)]);
    expect(roleStep(v, v.rows[1])).toEqual({ kind: 'blocked' });
    expect(roleStep(v, { kind: 'candidate' })).toEqual({ kind: 'blocked' });
  });

  test('an applicant with exactly one open role, which they ranked, approves directly into it', () => {
    const v = buildShiftView(shift(), [req(1)]);
    expect(roleStep(v, v.rows[0])).toEqual({ kind: 'direct', role: 'Bartender' });
  });

  test('an applicant with two open roles picks', () => {
    const v = buildShiftView(twoRoles, [req(1, { requested_positions: '["Barback","Bartender"]' })]);
    expect(roleStep(v, v.rows[0])).toEqual({ kind: 'pick', roles: [{ role: 'Bartender', open: 1 }, { role: 'Barback', open: 1 }] });
  });

  test('a waitlisted applicant picks even when only one role is open: it is a role they did not ask for', () => {
    const v = buildShiftView(twoRoles, [approved(1, 'Bartender'), req(2, { requested_positions: '["Bartender"]' })]);
    expect(v.rows[1].kind).toBe('waitlisted');
    expect(roleStep(v, v.rows[1])).toEqual({ kind: 'pick', roles: [{ role: 'Barback', open: 1 }] });
  });

  test('a candidate always picks, even with one open role', () => {
    const v = buildShiftView(shift(), []);
    expect(roleStep(v, { kind: 'candidate' })).toEqual({ kind: 'pick', roles: [{ role: 'Bartender', open: 3 }] });
  });

  test('a closed shift blocks everyone even with open roles', () => {
    const v = buildShiftView(shift({ finished: true }), [req(1)]);
    expect(v.openRoles.length).toBe(1);
    expect(roleStep(v, v.rows[0])).toEqual({ kind: 'blocked' });
    expect(roleStep(v, { kind: 'candidate' })).toEqual({ kind: 'blocked' });
  });

  test('every role a step can return is canonical', () => {
    const v = buildShiftView(shift({ positions_needed: '["bartender","server","BARBACK"]' }), [req(1, { requested_positions: '["server"]' })]);
    const step = roleStep(v, v.rows[0]);
    expect(step.kind).toBe('pick');
    expect(step.roles.map((r) => r.role)).toEqual(['Bartender', 'Banquet Server', 'Barback']);
  });
});

describe('candidatesOf', () => {
  const staff = [
    { id: 9, display_name: 'Tess Marsh', events_worked: 9, home_distance_miles: 8.1 },
    { id: 5, display_name: null, preferred_name: 'Ana Flores', events_worked: 33, home_distance_miles: null },
    { id: 101, display_name: 'Person 1', events_worked: 1, home_distance_miles: 1 },
    { id: 7, display_name: null, preferred_name: null, email: 'zed@example.com' },
  ];
  const view = buildShiftView(shift(), [approved(1)]);

  test('alphabetical, without anyone already on the shift, with plain meta', () => {
    const c = candidatesOf(staff, view, '');
    expect(c.map((x) => x.name)).toEqual(['Ana Flores', 'Tess Marsh', 'zed@example.com']);
    expect(c[0]).toMatchObject({ key: 'c5', kind: 'candidate', userId: 5, initials: 'AF', meta: '33 events' });
    expect(c[1].meta).toBe('9 events · 8 mi');
    expect(c[2].meta).toBe('');
  });

  test('search is case-insensitive and trims', () => {
    expect(candidatesOf(staff, view, '  tESS ').map((x) => x.name)).toEqual(['Tess Marsh']);
    expect(candidatesOf(staff, view, 'nobody')).toEqual([]);
  });

  test('a person whose request was denied or dropped is a candidate again', () => {
    const v = buildShiftView(shift(), [req(1, { status: 'denied' })]);
    expect(candidatesOf(staff, v, '').map((x) => x.userId)).toContain(101);
  });

  test('a missing staff list is an empty list', () => {
    expect(candidatesOf(null, view, '')).toEqual([]);
  });
});

test('confirmCopy names the consequences and never promises a notification', () => {
  expect(confirmCopy('remove', 'Lena Park')).toEqual({
    copy: 'Remove Lena Park from this shift? Payroll re-accrues and any out-of-area lock is released.',
    label: 'Remove',
  });
  const deny = confirmCopy('deny', 'Jo Ellis');
  expect(deny).toEqual({ copy: 'Deny Jo Ellis’s application? The request closes. They are not notified.', label: 'Deny' });
  expect(deny.copy).not.toMatch(/are notified and/);
});

test('the read-only notes carry no dash glyph', () => {
  expect(READ_ONLY_NOTE).toEqual({
    cancelled: 'Cancelled · roster is read-only',
    past: 'Past event · roster is read-only',
    rosterless: 'No roles are declared on this shift. Staff it from desktop view.',
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/staffingSheet.test.js`
Expected: FAIL, `Cannot find module './staffingSheet'`.

- [ ] **Step 3: Write the module**

Create `client/src/utils/staffingSheet.js`:

```js
// Pure staffing logic for the phone staffing card and the assignment sheet
// (spec 2026-08-13-mobile-admin section 4 Detail, benchmark 2026-09-15). No
// React, no fetch. It rides on staffingRoles.js, the same module the desktop
// ShiftDrawer classifies with, so a request is "waitlisted" on the phone
// exactly when it is on the desktop.
//
// THE MONEY SEAM. roleStep decides which `position` an approve or an assign
// may send, and `position` keys payroll's tip split. Its law: the role that is
// written is always a role the screen showed before the tap. It never
// defaults and never infers. defaultAssignRole (the desktop picker's
// preselect) is deliberately NOT imported here.
import {
  parsePositionsNeeded, rosterCounts, computeRemaining, classifyRequest, canonicalizeRole,
} from './staffingRoles';
import { neededCount, isCancelledEvent } from '../components/adminos/shifts';

export const READ_ONLY_NOTE = {
  cancelled: 'Cancelled · roster is read-only',
  past: 'Past event · roster is read-only',
  rosterless: 'No roles are declared on this shift. Staff it from desktop view.',
};

export function initialsOf(name) {
  const letters = String(name || '').trim().split(/\s+/).filter(Boolean).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  return letters || '?';
}

const known = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

// "14 events · 7 mi". Seniority and distance are facts Dallas decides on,
// shown as plain meta and never used to order anything. Either may be unknown
// (a person or a venue with no coordinates): an unknown fact is omitted, never
// rendered as a zero.
//
// WHOLE miles, always. The picker's distances arrive whole from the server
// (server/utils/staffingMeta.js), because these reads are stored on the phone
// and a tenth of a mile to ten venues places a home to the block. An
// applicant's distance arrives to the tenth, as the desktop shows it; the
// phone rounds it so every row reads alike.
export function staffMeta({ eventsWorked, miles } = {}) {
  const parts = [];
  if (known(eventsWorked)) {
    const n = Number(eventsWorked);
    parts.push(`${n} ${n === 1 ? 'event' : 'events'}`);
  }
  if (known(miles)) parts.push(`${Math.round(Number(miles))} mi`);
  return parts.join(' · ');
}

// GET /shifts/detail/:id returns request rows (id, staff_name); GET
// /shifts/by-proposal/:id returns requesters (request_id, name). One shape in.
export function normalizeRequest(raw) {
  const r = raw || {};
  return {
    requestId: r.request_id ?? r.id,
    userId: r.user_id,
    name: r.name || r.staff_name || r.staff_email || 'Staff member',
    status: r.status,
    position: canonicalizeRole(r.position),
    dropped: !!r.dropped_at,
    rankedRoles: [...new Set(parsePositionsNeeded(r.requested_positions))],
    miles: r.home_distance_miles ?? null,
    eventsWorked: r.events_worked ?? null,
  };
}

export function buildShiftView(shift, rawRequests, { justAssigned = [] } = {}) {
  const s = shift || {};
  const roster = parsePositionsNeeded(s.positions_needed);
  const rosterless = roster.length === 0;
  const needed = rosterCounts(roster);
  const roleOrder = Object.keys(needed);
  const requests = (Array.isArray(rawRequests) ? rawRequests : []).map(normalizeRequest);

  // `dropped` is load-bearing: an emergency drop leaves status 'approved' and
  // sets dropped_at, so a bare status check would count someone who already
  // bailed as filling their slot. Every server aggregate pairs the two.
  const approved = requests.filter((r) => r.status === 'approved' && !r.dropped);
  const pending = requests.filter((r) => r.status === 'pending');

  const approvedByRole = {};
  for (const r of approved) if (r.position) approvedByRole[r.position] = (approvedByRole[r.position] || 0) + 1;
  // An approval with no role on file (none in prod as of 2026-09-29, but the
  // column is nullable) still occupies a slot. Left uncounted, the phone would
  // show a filled slot as open and offer it again, which is an over-fill. It
  // takes the first role with room, in roster order: the same attribution
  // remainingByRole makes for a legacy row.
  for (const r of approved) {
    if (r.position) continue;
    const room = roleOrder.find((role) => needed[role] - (approvedByRole[role] || 0) > 0) || roleOrder[0];
    if (room) approvedByRole[room] = (approvedByRole[room] || 0) + 1;
  }
  const remaining = computeRemaining(roster, approvedByRole);
  const openRoles = roleOrder
    .map((role) => ({ role, open: Math.max(0, remaining[role] || 0) }))
    .filter((r) => r.open > 0);

  const slots = neededCount(roster);
  const open = rosterless
    ? Math.max(0, slots - approved.length)
    : openRoles.reduce((sum, r) => sum + r.open, 0);
  const filled = Math.max(0, slots - open);

  const cancelled = isCancelledEvent({ status: s.status, proposal_status: s.proposal_status });
  const closedReason = cancelled ? 'cancelled' : (s.finished ? 'past' : null);

  const byName = (a, b) => a.name.localeCompare(b.name);
  const rostered = approved.slice().sort(byName).map((r) => ({
    ...r,
    key: `r${r.requestId}`,
    kind: 'rostered',
    initials: initialsOf(r.name),
    resolvableRole: null,
    meta: [r.position || 'Staff', justAssigned.includes(r.userId) ? 'just assigned' : null].filter(Boolean).join(' · '),
  }));
  const asked = pending.map((r) => {
    const c = classifyRequest(r.rankedRoles, remaining);
    const ranked = r.rankedRoles.length ? r.rankedRoles.join(' › ') : 'Any role';
    return {
      ...r,
      key: `r${r.requestId}`,
      kind: c.state === 'actionable' ? 'applicant' : 'waitlisted',
      initials: initialsOf(r.name),
      resolvableRole: c.resolvableRole,
      meta: [ranked, staffMeta(r)].filter(Boolean).join(' · '),
    };
  });
  const applicants = asked.filter((r) => r.kind === 'applicant');
  const waitlisted = asked.filter((r) => r.kind === 'waitlisted');

  const pills = Array.from({ length: slots }, (_, i) => {
    if (i < filled) return 'filled';
    if (i < filled + applicants.length) return 'pending';
    return 'open';
  });

  return {
    shiftId: s.id ?? null,
    rosterless,
    closedReason,
    slots,
    filled,
    open,
    full: open === 0,
    count: `${filled}/${slots}`,
    openRoles,
    openLabel: openRoles.map((r) => `${r.role} × ${r.open}`).join(' · '),
    mix: roleOrder.map((role) => `${role} ${Math.min(needed[role], approvedByRole[role] || 0)}/${needed[role]}`).join(' · '),
    rolesLabel: rosterless ? 'Staff' : roleOrder.map((role) => `${role}s`).join(' + '),
    pills,
    rows: [...rostered, ...applicants, ...waitlisted],
  };
}

// What an Approve or an Assign tap must do for this row.
//   blocked: no open role, or the roster is read-only. Over-filling is a
//            deliberate desktop action; the phone never does it.
//   direct:  an applicant, exactly one role open, and it is the role their own
//            ranking resolves to. Approve is already the second tap (row, then
//            Approve), and the open role is named in the sheet head.
//   pick:    everything else shows one tap-row per open role. A waitlisted
//            applicant always picks (the open role is one they did not ask
//            for). A candidate always picks: an assignment texts and emails a
//            real person, so a single stray tap on a list row must never be
//            enough to fire it.
export function roleStep(view, row) {
  if (!view || view.closedReason || view.openRoles.length === 0) return { kind: 'blocked' };
  if (row && row.kind === 'applicant' && view.openRoles.length === 1
      && row.resolvableRole === view.openRoles[0].role) {
    return { kind: 'direct', role: row.resolvableRole };
  }
  return { kind: 'pick', roles: view.openRoles };
}

// The picker: active staff not already on this shift, alphabetical. Search
// narrows by name. No ranking, no scoring, no auto-assign.
export function candidatesOf(staff, view, query) {
  const taken = new Set(((view && view.rows) || []).map((r) => Number(r.userId)));
  const q = String(query || '').trim().toLowerCase();
  return (Array.isArray(staff) ? staff : [])
    .map((s) => ({
      userId: s.id,
      name: s.display_name || s.preferred_name || s.email || 'Staff member',
      miles: s.home_distance_miles ?? null,
      eventsWorked: s.events_worked ?? null,
    }))
    .filter((c) => !taken.has(Number(c.userId)))
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({
      key: `c${c.userId}`,
      kind: 'candidate',
      userId: c.userId,
      name: c.name,
      initials: initialsOf(c.name),
      meta: staffMeta(c),
    }));
}

// Remove is a hard DELETE of the request: payroll re-accrues on a completed
// event and the Out-of-Area lock releases (server/routes/shifts.js, DELETE
// /requests/:requestId). Deny closes the request and notifies NOBODY
// (shifts.approval.js sends only on approval), so the copy does not claim it.
export function confirmCopy(kind, name) {
  if (kind === 'remove') {
    return {
      copy: `Remove ${name} from this shift? Payroll re-accrues and any out-of-area lock is released.`,
      label: 'Remove',
    };
  }
  return {
    copy: `Deny ${name}’s application? The request closes. They are not notified.`,
    label: 'Deny',
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/staffingSheet.test.js`
Expected: PASS, 31 tests.

- [ ] **Step 5: Build and commit**

```bash
cd client && CI=true npx react-scripts build && cd .. && git add client/src/utils/staffingSheet.js client/src/utils/staffingSheet.test.js && git commit -F - <<'MSG'
feat(phone staffing): pure roster, open-role and role-step logic

buildShiftView turns a shift and its requests into roster rows, per-role
open counts and the read-only reason; roleStep decides whether an approve is
direct or shows role rows and blocks when nothing is open, so the phone never
over-fills and never sends a role the screen did not show. Rides on
staffingRoles, the module the desktop drawer classifies with.
MSG
```

---
### Task 5: The sheet, section and detail CSS

**Files:**
- Modify: `client/src/index.css` (the type-token line `:21247`; a new block inserted after the last Events list rule, `html[data-app="admin-os"][data-skin="light"] .m-empty.ok` at `:21375`, and before the Staff hub comment that opens at `:21377`)
- Test: `client/src/utils/mobileDetailCss.test.js`

**Interfaces:**
- Consumes: the existing `.m-header`, `.m-iconbtn`, `.m-stale`, `.m-stale-dot`, `.m-stale-time`, `.m-frac` (with its existing `full` and `past` states), `.m-retry-btn`, `.m-empty` rules and the `chip` primitives.
- Produces the class vocabulary Tasks 6, 8a and 8b render with. Header: `m-header-detail`, `m-dhead`, `m-dhead-line`, `m-dhead-title`, `m-dhead-kind`, `m-dhead-guests`, `m-dhead-venue`. Detail body: `m-detail-when`, `m-detail-whenline`, `m-detail-setup`, `m-section`, `m-section-row`, `m-section-name`, `m-section-sum`, `m-section-num`, `m-section-caret`, `m-section-caret-open`, `m-section-label`, `m-section-note`, `m-section-item`, `m-contact`, `m-contact-name`, `m-contact-line`, `m-contact-link`, `m-contact-act`, `m-shift-head`, `m-shift-label`, `m-money-row`, `m-money-main`, `m-money-label`, `m-money-sub`, `m-money-amt`, `m-money-total`, `m-money-bal`, `m-money-flight`, `m-money-paid`, `m-money-pay`, `m-edit-note`, `m-edit-note-locked`. People: `m-sheet-row`, `m-person`, `m-avatar`, `m-avatar-app`, `m-person-main`, `m-person-name`, `m-person-meta`, `m-person-check`, `m-person-go`, `m-person-go-off`, `m-assign-row`. Sheet: `m-sheet-scrim`, `m-sheet`, `m-sheet-handle`, `m-sheet-head`, `m-sheet-title`, `m-sheet-kind`, `m-sheet-when`, `m-pills`, `m-pill`, `m-pill-filled`, `m-pill-pending`, `m-pill-count`, `m-sheet-mix`, `m-sheet-venue`, `m-sheet-body`, `m-sheet-sec`, `m-sheet-sec-line`, `m-sheet-item`, `m-sheet-note`, `m-sheet-note-dot`, `m-sheet-note-text`, `m-acts`, `m-act`, `m-act-primary`, `m-act-quiet`, `m-act-danger`, `m-act-confirm`, `m-confirm`, `m-confirm-copy`, `m-confirm-btns`, `m-fail`, `m-fail-msg`, `m-fail-retry`, `m-role-label`, `m-role-name`, `m-role-open`, `m-sheet-searchwrap`, `m-sheet-search`, `m-sheet-nomatch`, `m-sheet-state`.

**Two colour laws, both learned on the Events list:**
- **Red is a literal in After Hours.** The dark skin sets `--danger-h` to 262 inline (`UserPrefsContext.js`), so `hsl(var(--danger-h) ...)` paints VIOLET. Dallas saw it on 2026-09-24 and had it changed. Anything that must read red (Remove, the confirm box, a failed save) uses `#ff4d4d` in the base rule and `var(--ms-bordeaux)` in the light-skin rule.
- **A modifier is its own class.** `.m-act-danger`, never `.m-act.danger`.

- [ ] **Step 1: Write the failing test**

Create `client/src/utils/mobileDetailCss.test.js`:

```js
import '@testing-library/jest-dom';
import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');
const START = '/* ---- Mobile admin: event detail and assignment sheet';
const END = '/* ---- end: event detail and assignment sheet ---- */';
const block = css.slice(css.indexOf(START), css.indexOf(END));

const VOCABULARY = [
  'm-header-detail', 'm-dhead', 'm-dhead-line', 'm-dhead-title', 'm-dhead-kind', 'm-dhead-guests', 'm-dhead-venue',
  'm-detail-when', 'm-detail-whenline', 'm-detail-setup',
  'm-section', 'm-section-row', 'm-section-name', 'm-section-sum', 'm-section-num', 'm-section-caret',
  'm-section-caret-open', 'm-section-label', 'm-section-note', 'm-section-item',
  'm-contact', 'm-contact-name', 'm-contact-line', 'm-contact-link', 'm-contact-act',
  'm-shift-head', 'm-shift-label',
  'm-money-row', 'm-money-main', 'm-money-label', 'm-money-sub', 'm-money-amt', 'm-money-total', 'm-money-bal',
  'm-money-flight', 'm-money-paid', 'm-money-pay', 'm-edit-note', 'm-edit-note-locked',
  'm-sheet-row', 'm-person', 'm-avatar', 'm-avatar-app', 'm-person-main', 'm-person-name', 'm-person-meta',
  'm-person-check', 'm-person-go', 'm-person-go-off', 'm-assign-row',
  'm-sheet-scrim', 'm-sheet', 'm-sheet-handle', 'm-sheet-head', 'm-sheet-title', 'm-sheet-kind', 'm-sheet-when',
  'm-pills', 'm-pill', 'm-pill-filled', 'm-pill-pending', 'm-pill-count', 'm-sheet-mix', 'm-sheet-venue',
  'm-sheet-body', 'm-sheet-sec', 'm-sheet-sec-line', 'm-sheet-item', 'm-sheet-note', 'm-sheet-note-dot',
  'm-sheet-note-text', 'm-acts', 'm-act', 'm-act-primary', 'm-act-quiet', 'm-act-danger', 'm-act-confirm',
  'm-confirm', 'm-confirm-copy', 'm-confirm-btns', 'm-fail', 'm-fail-msg', 'm-fail-retry',
  'm-role-label', 'm-role-name', 'm-role-open', 'm-sheet-searchwrap', 'm-sheet-search', 'm-sheet-nomatch',
  'm-sheet-state',
];

test('the block exists, between the Events list rules and the Staff hub block', () => {
  expect(css.indexOf(START)).toBeGreaterThan(css.lastIndexOf('.m-empty.ok'));
  expect(css.indexOf(END)).toBeGreaterThan(css.indexOf(START));
  expect(css.indexOf('Staff hub chrome')).toBeGreaterThan(css.indexOf(END));
});

test.each(VOCABULARY)('.%s has a rule', (name) => {
  expect(block).toMatch(new RegExp(`\\.${name}(?![a-z0-9-])`));
});

test('every rule is scoped to the admin app', () => {
  const selectors = block.split('}').map((chunk) => chunk.split('{')[0].trim())
    .filter((s) => s && !s.startsWith('/*') && !s.startsWith('@') && !/^(from|to|\d+%)/.test(s));
  const loose = selectors.flatMap((s) => s.split(',').map((x) => x.replace(/\/\*[\s\S]*?\*\//g, '').trim()))
    .filter((s) => s && !s.startsWith('html[data-app="admin-os"]'));
  expect(loose).toEqual([]);
});

test('no bare modifier: a compound class selector pairs m-* only with m-*', () => {
  const compounds = block.match(/\.m-[a-z0-9-]+\.[a-z][a-z0-9-]*/g) || [];
  expect(compounds.filter((c) => !/^\.m-[a-z0-9-]+\.m-[a-z0-9-]+$/.test(c))).toEqual([]);
});

test('red is a literal in the dark skin: no computed danger colour in this block', () => {
  expect(block).not.toMatch(/--danger-h/);
  expect(block).toMatch(/#ff4d4d/);
  expect(block).toMatch(/\[data-skin="light"\][^{]*\.m-act-danger[^{]*\{[^}]*--ms-bordeaux/);
});

test('no width media query and no dash glyph', () => {
  expect(block).not.toMatch(/@media/);
  expect(block.includes(String.fromCharCode(0x2014))).toBe(false);
});

test('the sheet sits above the chrome and below the lock', () => {
  const z = (name) => Number((block.match(new RegExp(`\\.${name} \\{[^}]*z-index: (\\d+)`)) || [])[1]);
  expect(z('m-sheet-scrim')).toBe(900);
  expect(z('m-sheet')).toBe(901);
  expect(css).toMatch(/\.m-lock \{[^}]*z-index: 10000/);
});

test('House Lights sections keep the border and the flat surface the More list has', () => {
  expect(block).toMatch(/\[data-skin="light"\] \.m-section \{[^}]*border-color: var\(--line-2\);[^}]*box-shadow: none;/);
});

test('the h3 type token is defined beside the other two', () => {
  expect(css).toMatch(/html\[data-app="admin-os"\] \{[^}]*--fs-body: 13px;[^}]*--fs-meta: 11\.5px;[^}]*--fs-h3: 13px;/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/mobileDetailCss.test.js`
Expected: `Tests: 95 failed, 3 passed, 98 total` (measured in a scratch copy, 2026-09-29). The block does not exist, so `block` is empty: all 90 vocabulary cases fail, and so do the placement, red-literal, z-index, House Lights and type-token tests. Three tests PASS on the empty block and mean nothing yet ("every rule is scoped", "no bare modifier", "no width media query and no dash glyph"); they start to bite in Step 5.

- [ ] **Step 3: Define the type token**

In `client/src/index.css`, replace the line at `:21247`:

```css
html[data-app="admin-os"] { --fs-body: 13px; --fs-meta: 11.5px; --fs-h3: 13px; }
```

- [ ] **Step 4: Add the block**

Insert after the rule `html[data-app="admin-os"][data-skin="light"] .m-empty.ok { ... }` (`:21375`) and before the blank line and comment that open the Staff hub block:

```css
/* ---- Mobile admin: event detail and assignment sheet (spec 2026-08-13
   section 4 Detail, benchmark
   docs/design-artifacts/2026-09-15-mobile-admin-shell.dc.html, Event detail
   and Assignment sheet). The sheet rules are folded from the design system's
   components-mobile.css and the pills from components-admin.css; the
   sections, people rows, action buttons and money rows promote the
   benchmark's inline treatment to classes (the benchmark reused .m-more-list
   and .m-more-row for its accordion; .m-section is that, promoted).
   Two laws. A modifier is its own m-* class, never a bare word beside one.
   And red is the literal #ff4d4d here: the After Hours palette sets
   the danger hue to violet inline, so a computed danger colour reads purple. ---- */

/* Rich detail header, inside .m-header */
html[data-app="admin-os"] .m-header.m-header-detail { min-height: 60px; padding: 8px 8px 8px 2px; }
html[data-app="admin-os"] .m-dhead { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
html[data-app="admin-os"] .m-dhead-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
html[data-app="admin-os"] .m-dhead-title {
  flex: 1; min-width: 0; margin: 0; font-size: 16px; font-weight: 600; font-family: var(--font-display);
  color: var(--ink-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
html[data-app="admin-os"] .m-dhead-kind { color: var(--ink-3); font-weight: 400; }
html[data-app="admin-os"] .m-dhead-guests { flex: none; font-family: var(--font-numeric); font-size: 11.5px; color: var(--ink-3); }
html[data-app="admin-os"] .m-dhead-guests small { font-family: var(--font-mono); font-size: 8.5px; letter-spacing: 0.1em; color: var(--ink-4); }
/* The link is one line of 11.5px text; the padding and the matching negative
   margin give it a 44px touch area without moving anything. */
html[data-app="admin-os"] .m-dhead-venue {
  display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 100%;
  padding: 13px 0; margin: -13px 0;
  font-family: var(--font-numeric); font-size: 11.5px; font-weight: 600; line-height: 18px;
  color: hsl(var(--accent-h) var(--accent-s) 62%); text-decoration: none;
}
html[data-app="admin-os"] .m-dhead-venue span { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
html[data-app="admin-os"] .m-dhead-venue svg { flex: none; }

/* When and setup lines */
html[data-app="admin-os"] .m-detail-when { display: flex; flex-direction: column; gap: 4px; margin: 0 0 10px; }
html[data-app="admin-os"] .m-detail-whenline { display: flex; align-items: center; gap: 8px; font-family: var(--font-numeric); font-size: 12.5px; color: var(--ink-2); }
html[data-app="admin-os"] .m-detail-setup { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.05em; color: var(--ink-3); }

/* Accordion sections */
html[data-app="admin-os"] .m-section {
  margin-bottom: 0.5rem; background: var(--bg-2); border: 1px solid var(--line-1);
  border-radius: var(--radius-lg); overflow: hidden;
}
html[data-app="admin-os"] .m-section-row {
  display: flex; align-items: center; gap: 0.75rem; width: 100%; min-height: 48px; padding: 0 1rem;
  background: none; border: none; color: var(--ink-1); font-size: 13px; font-family: var(--font-ui);
  text-align: left; cursor: pointer;
}
html[data-app="admin-os"] .m-section-row:active { background: var(--row-hover); }
html[data-app="admin-os"] .m-section-row:disabled { cursor: default; }
html[data-app="admin-os"] .m-section-name { flex: 1; }
html[data-app="admin-os"] .m-section-sum { flex: none; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-4); }
html[data-app="admin-os"] .m-section-num { flex: none; font-family: var(--font-numeric); font-size: 12px; color: var(--ink-2); }
html[data-app="admin-os"] .m-section-row .m-frac,
html[data-app="admin-os"] .m-shift-head .m-frac { flex: none; font-size: 12px; }
html[data-app="admin-os"] .m-section-caret { flex: none; display: flex; color: var(--ink-4); transition: transform 120ms ease; }
html[data-app="admin-os"] .m-section-caret.m-section-caret-open { transform: rotate(90deg); }
html[data-app="admin-os"] .m-section-label {
  border-top: 1px solid var(--line-1); padding: 10px 16px 4px;
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3);
}
html[data-app="admin-os"] .m-section-note {
  padding: 4px 16px 12px; display: flex; align-items: center; gap: 8px;
  font-size: var(--fs-meta); color: var(--ink-3); line-height: 1.5;
}
html[data-app="admin-os"] .m-section-note svg { flex: none; color: var(--ink-4); }

/* Contacts: every number and address is a tap target */
html[data-app="admin-os"] .m-contact { padding: 0 16px 8px; display: flex; flex-direction: column; }
html[data-app="admin-os"] .m-contact-name { padding-top: 6px; font-size: var(--fs-body); font-weight: 600; color: var(--ink-1); }
html[data-app="admin-os"] .m-contact-line { display: flex; align-items: center; gap: 8px; min-height: 44px; }
html[data-app="admin-os"] .m-contact-link {
  flex: 1; min-width: 0; min-height: 44px; display: flex; align-items: center;
  font-family: var(--font-numeric); font-size: 12.5px; color: hsl(var(--accent-h) var(--accent-s) 62%);
  text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
html[data-app="admin-os"] .m-contact-act {
  flex: none; min-width: 56px; min-height: 44px; padding: 0 12px; box-sizing: border-box;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--line-2); border-radius: var(--radius);
  font-family: var(--font-ui); font-size: 12px; font-weight: 600; color: var(--ink-2); text-decoration: none;
}

/* Staffing card: a head per shift when the event has more than one */
html[data-app="admin-os"] .m-shift-head { border-top: 1px solid var(--line-1); display: flex; align-items: center; gap: 8px; padding: 9px 16px 5px; }
html[data-app="admin-os"] .m-shift-label {
  flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* People rows: the staffing card, the sheet roster and the picker share them */
html[data-app="admin-os"] .m-sheet-row,
html[data-app="admin-os"] .m-section-item {
  display: flex; align-items: center; gap: 0.75rem; width: 100%; min-height: 48px; padding: 0 1rem;
  background: none; border: none; border-top: 1px solid var(--line-1);
  color: var(--ink-1); font-size: var(--fs-body); font-family: var(--font-ui); text-align: left; cursor: pointer;
}
html[data-app="admin-os"] .m-sheet-row:active,
html[data-app="admin-os"] .m-section-item:active { background: var(--row-hover); }
html[data-app="admin-os"] .m-sheet-row:disabled,
html[data-app="admin-os"] .m-section-item:disabled { cursor: default; }
html[data-app="admin-os"] .m-sheet-row.m-person,
html[data-app="admin-os"] .m-section-item.m-person { padding-top: 7px; padding-bottom: 7px; }
html[data-app="admin-os"] .m-avatar {
  width: 30px; height: 30px; flex: none; display: flex; align-items: center; justify-content: center;
  border-radius: var(--radius-sm); background: var(--bg-3); color: var(--ink-2);
  font-family: var(--font-mono); font-size: 11px; font-weight: 600;
}
html[data-app="admin-os"] .m-avatar.m-avatar-app { background: var(--accent-soft); color: var(--accent); }
html[data-app="admin-os"] .m-person-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
html[data-app="admin-os"] .m-person-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
html[data-app="admin-os"] .m-person-meta { font-family: var(--font-numeric); font-size: 11px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
html[data-app="admin-os"] .m-person-check { flex: none; display: flex; color: hsl(var(--ok-h) var(--ok-s) 52%); }
html[data-app="admin-os"] .m-person-go { flex: none; font-size: 12.5px; font-weight: 600; color: hsl(var(--accent-h) var(--accent-s) 62%); }
html[data-app="admin-os"] .m-person-go.m-person-go-off { color: var(--ink-4); }
html[data-app="admin-os"] .m-sheet-row.m-assign-row,
html[data-app="admin-os"] .m-section-item.m-assign-row { color: hsl(var(--accent-h) var(--accent-s) 62%); font-weight: 600; }

/* Financials */
html[data-app="admin-os"] .m-money-row { padding: 7px 16px; display: flex; align-items: center; gap: 8px; }
html[data-app="admin-os"] .m-money-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
html[data-app="admin-os"] .m-money-label { font-size: var(--fs-body); color: var(--ink-2); }
html[data-app="admin-os"] .m-money-sub { font-family: var(--font-numeric); font-size: 11px; color: var(--ink-3); }
html[data-app="admin-os"] .m-money-amt { flex: none; font-family: var(--font-numeric); font-size: 12.5px; color: var(--ink-1); }
html[data-app="admin-os"] .m-money-row.m-money-pay { padding: 6px 16px; }
html[data-app="admin-os"] .m-money-row.m-money-total { border-top: 1px solid var(--line-2); padding: 9px 16px; }
html[data-app="admin-os"] .m-money-total .m-money-label,
html[data-app="admin-os"] .m-money-total .m-money-amt { font-weight: 600; color: var(--ink-1); }
html[data-app="admin-os"] .m-money-row.m-money-bal { border-top: 1px solid var(--line-2); padding: 8px 16px 10px; }
html[data-app="admin-os"] .m-money-bal .m-money-label,
html[data-app="admin-os"] .m-money-bal .m-money-amt { font-weight: 600; color: hsl(var(--warn-h) var(--warn-s) 58%); }
/* A payment is already on its way: the balance is a fact, not a chase. */
html[data-app="admin-os"] .m-money-bal.m-money-flight .m-money-label,
html[data-app="admin-os"] .m-money-bal.m-money-flight .m-money-amt { color: var(--ink-2); }
html[data-app="admin-os"] .m-money-row.m-money-paid { border-top: 1px solid var(--line-2); padding: 9px 16px 11px; }
html[data-app="admin-os"] .m-money-paid .m-money-label,
html[data-app="admin-os"] .m-money-paid .m-money-amt { font-weight: 600; color: hsl(var(--ok-h) var(--ok-s) 52%); }

/* Edit details row */
html[data-app="admin-os"] .m-edit-note {
  flex: none; display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-4);
}
html[data-app="admin-os"] .m-edit-note.m-edit-note-locked { color: var(--ink-3); }

/* The bottom sheet. Above the chrome (tab bar, header, return pill at 39),
   below the lock (10000) and the toasts. */
html[data-app="admin-os"] .m-sheet-scrim {
  position: fixed; inset: 0; z-index: 900; width: 100%; height: 100%; padding: 0; border: none;
  background: rgba(0, 0, 0, 0.5); animation: m-sheet-fade 180ms ease;
}
html[data-app="admin-os"] .m-sheet {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 901; max-height: 80dvh;
  display: flex; flex-direction: column; outline: none;
  background: var(--bg-elev); border: 1px solid var(--line-2); border-bottom: none;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0; box-shadow: var(--shadow-pop);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  animation: m-sheet-up 240ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
@keyframes m-sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
@keyframes m-sheet-fade { from { opacity: 0; } to { opacity: 1; } }
html[data-app="admin-os"] .m-sheet-handle { flex: none; width: 36px; height: 4px; border-radius: 2px; background: var(--line-3); margin: 8px auto 4px; }
html[data-app="admin-os"] .m-sheet-head { flex: none; padding: 2px 16px 10px; border-bottom: 1px solid var(--line-1); }
html[data-app="admin-os"] .m-sheet-title { margin: 0; font-size: var(--fs-h3); font-weight: 600; font-family: var(--font-ui); color: var(--ink-1); }
html[data-app="admin-os"] .m-sheet-kind { color: var(--ink-3); font-weight: 400; }
html[data-app="admin-os"] .m-sheet-when { display: flex; align-items: center; gap: 8px; margin-top: 5px; font-family: var(--font-numeric); font-size: var(--fs-meta); color: var(--ink-3); }
html[data-app="admin-os"] .m-pills { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; }
html[data-app="admin-os"] .m-pill { width: 14px; height: 6px; border-radius: 2px; background: var(--line-2); }
html[data-app="admin-os"] .m-pill.m-pill-filled { background: hsl(var(--ok-h) var(--ok-s) 52%); }
html[data-app="admin-os"] .m-pill.m-pill-pending { background: hsl(var(--warn-h) var(--warn-s) 55%); }
html[data-app="admin-os"] .m-pill-count { margin-left: 4px; font-family: var(--font-numeric); font-size: 11.5px; color: var(--ink-2); }
html[data-app="admin-os"] .m-sheet-mix { margin-top: 4px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); }
html[data-app="admin-os"] .m-sheet-venue { margin-top: 4px; font-family: var(--font-numeric); font-size: 11px; color: var(--ink-3); }
html[data-app="admin-os"] .m-sheet-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-bottom: 6px; }
html[data-app="admin-os"] .m-sheet-sec { padding: 12px 16px 6px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3); }
html[data-app="admin-os"] .m-sheet-sec.m-sheet-sec-line { border-top: 1px solid var(--line-1); }
html[data-app="admin-os"] .m-sheet-item { border-top: 1px solid var(--line-1); }
html[data-app="admin-os"] .m-sheet-item > .m-sheet-row { border-top: none; }
html[data-app="admin-os"] .m-sheet-note {
  margin: 10px 16px 2px; padding: 10px 12px; display: flex; gap: 8px; align-items: flex-start;
  border: 1px solid var(--line-2); border-radius: var(--radius);
}
html[data-app="admin-os"] .m-sheet-note .m-fail-retry { align-self: center; }
html[data-app="admin-os"] .m-sheet-note-dot { width: 6px; height: 6px; flex: none; margin-top: 5px; border-radius: 50%; background: hsl(var(--warn-h) var(--warn-s) 52%); }
html[data-app="admin-os"] .m-sheet-note-text { flex: 1; font-size: var(--fs-meta); color: var(--ink-2); line-height: 1.5; }
html[data-app="admin-os"] .m-sheet-state { padding: 22px 16px; text-align: center; font-size: var(--fs-meta); color: var(--ink-3); line-height: 1.5; }

/* Row actions, the confirm and the failed save */
html[data-app="admin-os"] .m-acts { padding: 0 16px 10px; display: flex; gap: 8px; }
html[data-app="admin-os"] .m-act {
  flex: 1; min-height: 44px; padding: 0 12px; border-radius: var(--radius);
  font-family: var(--font-ui); font-size: 12.5px; font-weight: 600; cursor: pointer;
}
html[data-app="admin-os"] .m-act:disabled { opacity: 0.45; cursor: default; }
html[data-app="admin-os"] .m-act.m-act-primary { border: none; background: var(--accent); color: #fff; }
html[data-app="admin-os"] .m-act.m-act-quiet { border: 1px solid var(--line-2); background: var(--bg-2); color: var(--ink-2); }
html[data-app="admin-os"] .m-act.m-act-danger { border: 1px solid rgba(255, 77, 77, 0.6); background: transparent; color: #ff4d4d; }
html[data-app="admin-os"] .m-act.m-act-confirm { border: 1px solid rgba(255, 77, 77, 0.6); background: rgba(255, 77, 77, 0.14); color: #ff4d4d; }
html[data-app="admin-os"] .m-confirm {
  margin: 0 16px 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
  border: 1px solid rgba(255, 77, 77, 0.6); border-radius: var(--radius);
}
html[data-app="admin-os"] .m-confirm-copy { font-size: var(--fs-meta); color: var(--ink-2); line-height: 1.5; }
html[data-app="admin-os"] .m-confirm-btns { display: flex; gap: 8px; }
html[data-app="admin-os"] .m-fail {
  margin: 0 16px 10px; padding: 9px 12px; display: flex; align-items: center; gap: 8px;
  border: 1px solid rgba(255, 77, 77, 0.6); border-radius: var(--radius);
}
html[data-app="admin-os"] .m-fail-msg { flex: 1; font-size: var(--fs-meta); color: #ff4d4d; line-height: 1.5; }
html[data-app="admin-os"] .m-fail-retry {
  flex: none; min-height: 44px; padding: 0 12px; border: 1px solid var(--line-2); border-radius: var(--radius);
  background: var(--bg-2); color: var(--ink-1); font-family: var(--font-ui); font-size: 12px; font-weight: 600; cursor: pointer;
}
html[data-app="admin-os"] .m-fail-retry:disabled { opacity: 0.45; cursor: default; }

/* Role rows and the picker */
html[data-app="admin-os"] .m-role-label { padding: 2px 16px 4px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3); }
html[data-app="admin-os"] .m-role-name { flex: 1; }
html[data-app="admin-os"] .m-role-open { flex: none; font-family: var(--font-numeric); font-size: 11.5px; color: var(--ink-3); }
html[data-app="admin-os"] .m-sheet-searchwrap { padding: 0 16px 8px; }
html[data-app="admin-os"] .m-sheet-search {
  width: 100%; box-sizing: border-box; min-height: 44px; padding: 0 12px;
  border: 1px solid var(--line-2); border-radius: var(--radius); background: var(--bg-3); color: var(--ink-1);
  font-family: var(--font-ui); font-size: 12.5px; -webkit-appearance: none; appearance: none;
}
/* type="search" draws its own clear button; the design has none here. */
html[data-app="admin-os"] .m-sheet-search::-webkit-search-cancel-button { -webkit-appearance: none; display: none; }
html[data-app="admin-os"] .m-sheet-search:disabled { opacity: 0.5; }
html[data-app="admin-os"] .m-sheet-nomatch { padding: 18px 16px 8px; text-align: center; font-size: var(--fs-meta); color: var(--ink-3); }

/* House Lights: squared corners, the skin's own ink for links, red, green and amber */
html[data-app="admin-os"][data-skin="light"] .m-section { border-color: var(--line-2); box-shadow: none; }
html[data-app="admin-os"][data-skin="light"] .m-section,
html[data-app="admin-os"][data-skin="light"] .m-sheet,
html[data-app="admin-os"][data-skin="light"] .m-sheet-note,
html[data-app="admin-os"][data-skin="light"] .m-act,
html[data-app="admin-os"][data-skin="light"] .m-confirm,
html[data-app="admin-os"][data-skin="light"] .m-fail,
html[data-app="admin-os"][data-skin="light"] .m-fail-retry,
html[data-app="admin-os"][data-skin="light"] .m-contact-act,
html[data-app="admin-os"][data-skin="light"] .m-sheet-search,
html[data-app="admin-os"][data-skin="light"] .m-avatar { border-radius: 0; }
html[data-app="admin-os"][data-skin="light"] .m-dhead-venue,
html[data-app="admin-os"][data-skin="light"] .m-contact-link,
html[data-app="admin-os"][data-skin="light"] .m-person-go,
html[data-app="admin-os"][data-skin="light"] .m-sheet-row.m-assign-row,
html[data-app="admin-os"][data-skin="light"] .m-section-item.m-assign-row { color: var(--accent); }
html[data-app="admin-os"][data-skin="light"] .m-person-go.m-person-go-off { color: var(--ink-4); }
html[data-app="admin-os"][data-skin="light"] .m-avatar.m-avatar-app { color: var(--accent-ink); }
html[data-app="admin-os"][data-skin="light"] .m-act.m-act-primary { color: var(--bg-0); }
html[data-app="admin-os"][data-skin="light"] .m-act.m-act-danger,
html[data-app="admin-os"][data-skin="light"] .m-act.m-act-confirm { border-color: var(--ms-bordeaux); background: transparent; color: var(--ms-bordeaux); }
html[data-app="admin-os"][data-skin="light"] .m-confirm,
html[data-app="admin-os"][data-skin="light"] .m-fail { border-color: var(--ms-bordeaux); }
html[data-app="admin-os"][data-skin="light"] .m-fail-msg { color: var(--ms-bordeaux); }
html[data-app="admin-os"][data-skin="light"] .m-person-check,
html[data-app="admin-os"][data-skin="light"] .m-money-paid .m-money-label,
html[data-app="admin-os"][data-skin="light"] .m-money-paid .m-money-amt,
html[data-app="admin-os"][data-skin="light"] .m-pill.m-pill-filled { color: var(--ms-emerald); }
html[data-app="admin-os"][data-skin="light"] .m-pill.m-pill-filled { background: var(--ms-emerald); }
html[data-app="admin-os"][data-skin="light"] .m-money-bal .m-money-label,
html[data-app="admin-os"][data-skin="light"] .m-money-bal .m-money-amt { color: var(--ms-camel); }
html[data-app="admin-os"][data-skin="light"] .m-money-bal.m-money-flight .m-money-label,
html[data-app="admin-os"][data-skin="light"] .m-money-bal.m-money-flight .m-money-amt { color: var(--ink-2); }
html[data-app="admin-os"][data-skin="light"] .m-pill.m-pill-pending,
html[data-app="admin-os"][data-skin="light"] .m-sheet-note-dot { background: var(--ms-camel); }
/* ---- end: event detail and assignment sheet ---- */
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/mobileDetailCss.test.js`
Expected: PASS, 98 tests (90 vocabulary cases plus eight structural tests).

- [ ] **Step 6: Run the palette scope check and the build**

Run: `npm run check:css-scope && cd client && CI=true npx react-scripts build`
Expected: the scope check prints no violation and exits 0; the build exits 0 with no warning.

- [ ] **Step 7: Commit**

```bash
git add client/src/index.css client/src/utils/mobileDetailCss.test.js && git commit -F - <<'MSG'
style(phone detail): sheet, section, people-row and money-row classes

Folds the design system's bottom-sheet rules and staffing pills into the
mobile block and promotes the benchmark's inline accordion, roster rows,
action buttons, confirm, failed-save and money rows to m-* classes. Every
modifier is its own m-* class. Red is the literal ff4d4d in After Hours
because that skin sets the danger hue to violet. Defines the h3 type token.
MSG
```

---
### Task 6: `AssignmentSheet`, the phone ShiftDrawer for one shift

**Files:**
- Create: `client/src/components/mobile/AssignmentSheet.js`
- Test: `client/src/components/mobile/AssignmentSheet.test.js`

**Interfaces:**
- Consumes: Task 1's reads as amended by Task 3b (`GET /shifts/detail/:id` -> `{ shift, requests }`; `GET /admin/active-staff` with `params: { limit: 100, shift_id }` -> `{ staff }`, distances in whole miles); Task 3b's `offlineGet(url, config?)` from `client/src/utils/offlineRead.js`; Task 4's `buildShiftView`, `candidatesOf`, `roleStep`, `confirmCopy`, `READ_ONLY_NOTE`; Task 5's classes; `groupShiftRows` and `railParts` from `client/src/utils/eventCards.js`; `api` (`res.staleAt` on a cache-served read; rejections shaped `{ message, code, status }`).
- Produces, for Tasks 8b and 9: the default export `AssignmentSheet({ shiftId, focusUserId, onClose, onChanged, onDead })`. Both owners mount it with `key={drawer.id}`, so its state never carries from one shift to the next.
  - `shiftId: number` (required). `focusUserId: string | number | null` expands that person's row once the roster loads.
  - `onClose()` is called by the scrim, by Escape, and on a dead read when no `onDead` is given. The component never touches the URL; its owner does.
  - `onChanged()` is called after every successful write, once the sheet has re-read its roster.
  - `onDead()` is called instead of `onClose` when the shift read answers 404 or 403.
  - The component is mounted only while open. It renders the scrim and `role="dialog"`.

**Behaviour, stated once:**
- Approve and Assign both `POST /shifts/:id/assign { user_id, position }`. Deny is `PUT /shifts/requests/:requestId { status: 'denied' }`. Remove is `DELETE /shifts/requests/:requestId`. Same endpoints, same bodies as the desktop drawer.
- The roster and the picker are read with `offlineGet`: they may be answered from the phone's cache, and when they are (`res.staleAt`) the sheet is read-only.
- Before an approve or an assign is sent, the sheet re-reads the shift with a plain `api.get`, which the service worker never answers from its store: it is the network or an error. A roster in which the chosen role is no longer open is a refusal ("The roster changed. Check the open roles and try again."). Only then does the POST go out. (The code also treats a `staleAt` on that re-read as a lost connection; with opt-in caching that cannot happen, and the check stays as a second lock.)
- One write at a time, held by a ref. After a success the sheet re-reads the roster and the picker and calls `onChanged`. After a server refusal it re-reads the roster so the screen shows the truth. After a transport failure it re-reads nothing.
- A failure renders under the row it came from, with Retry, which repeats the same write. If that row is gone after the re-read, the failure renders at the top of the body. Opening any other action (Approve, Deny, Remove) drops the failure box first, so Retry can never repeat a write the screen has moved on from.
- A cache-served roster, a finished shift and a cancelled shift are read-only. A shift with no declared roles allows Deny and Remove and blocks Approve and Assign.

- [ ] **Step 1: Write the failing test**

Create `client/src/components/mobile/AssignmentSheet.test.js`:

```js
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import AssignmentSheet from './AssignmentSheet';
import api from '../../utils/api';
import { railParts } from '../../utils/eventCards';

jest.mock('../../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() },
}));

const shiftRow = (over = {}) => ({
  id: 17, proposal_id: 10, client_name: 'Henderson', event_type: 'wedding-reception', event_type_custom: null,
  event_date: '2999-08-15', start_time: '18:00', end_time: '23:00', location: 'Grove on the River',
  positions_needed: '["Bartender","Bartender","Bartender"]', status: 'open', proposal_status: 'deposit_paid',
  finished: false, approved_count: 2, ...over,
});
const reqRow = (id, over = {}) => ({
  id, user_id: 100 + id, staff_name: `Person ${id}`, status: 'pending', position: null, dropped_at: null,
  requested_positions: '["Bartender"]', home_distance_miles: 6.8, events_worked: 14, ...over,
});
const onShift = (id, role = 'Bartender', over = {}) => reqRow(id, { status: 'approved', position: role, ...over });
const STAFF = [
  { id: 9, display_name: 'Tess Marsh', events_worked: 9, home_distance_miles: 8 },
  { id: 5, display_name: 'Ana Flores', events_worked: 33, home_distance_miles: null },
  { id: 101, display_name: 'Person 1', events_worked: 1, home_distance_miles: 1 },
];
const TWO_ROLES = '["Bartender","Barback"]';
const NETWORK = { status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' };
const OFFLINE_OK = { headers: { 'X-Offline-Ok': '1' } };
// The reads that may come from the phone's cache carry the header; the re-read
// before a write never does.
const detailReads = () => api.get.mock.calls.filter((c) => c[0] === '/shifts/detail/17');
const offlineReads = () => detailReads().filter((c) => c[1] && c[1].headers && c[1].headers['X-Offline-Ok'] === '1');
const liveReads = () => detailReads().filter((c) => !c[1]);

// detail may be one payload, or a list served in order (the last one repeats).
function serve({ detail, staff = STAFF, staffFails = false } = {}) {
  const queue = Array.isArray(detail) ? detail.slice() : [detail];
  api.get.mockImplementation((url) => {
    if (url === '/shifts/detail/17') {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return next instanceof Error || next.reject ? Promise.reject(next.reject || next) : Promise.resolve(next);
    }
    if (url === '/admin/active-staff') {
      return staffFails ? Promise.reject(NETWORK) : Promise.resolve({ data: { staff } });
    }
    return Promise.reject({ status: 404, message: 'Not found' });
  });
}
const payload = (requests, shiftOver = {}, extra = {}) => ({ data: { shift: shiftRow(shiftOver), requests }, ...extra });

const handlers = () => ({ onClose: jest.fn(), onChanged: jest.fn(), onDead: jest.fn() });
function mount(props = {}) {
  const h = handlers();
  render(<AssignmentSheet shiftId={17} {...h} {...props} />);
  return h;
}
const row = (name) => screen.getByRole('button', { name: new RegExp(name) });
const tap = (el) => fireEvent.click(el);

beforeEach(() => {
  api.post.mockResolvedValue({ data: {} });
  api.put.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: { success: true } });
});

test('reads the shift and the picker for THIS shift, and renders the head and the roster', async () => {
  serve({ detail: payload([onShift(1, 'Bartender', { staff_name: 'Lena Park' }), onShift(2, 'Bartender', { staff_name: 'Sam Ortiz' }), reqRow(3)]) });
  mount();
  const dialog = await screen.findByRole('dialog');
  expect(api.get).toHaveBeenCalledWith('/shifts/detail/17', OFFLINE_OK);
  expect(api.get).toHaveBeenCalledWith('/admin/active-staff', { params: { limit: 100, shift_id: 17 }, ...OFFLINE_OK });
  await within(dialog).findByText('Lena Park');
  const rail = railParts('2999-08-15');
  expect(within(dialog).getByRole('heading')).toHaveTextContent('Henderson · Wedding Reception');
  expect(within(dialog).getByText(`${rail.dow} ${rail.mon} ${rail.day} · 18:00–23:00 · 5h`)).toBeInTheDocument();
  expect(within(dialog).getByText('2/3')).toHaveClass('m-pill-count');
  expect(within(dialog).getByText('Bartender 2/3')).toHaveClass('m-sheet-mix');
  expect(within(dialog).getByText('On this shift')).toBeInTheDocument();
  expect(within(row('Person 3')).getByText('Pending')).toBeInTheDocument();
  expect(within(row('Person 3')).getByText('Bartender · 14 events · 7 mi')).toHaveClass('m-person-meta');
  expect(within(dialog).getByText('Assign · Bartender × 1')).toBeInTheDocument();
  // A booked event does not repeat its venue in the sheet head.
  expect(within(dialog).queryByText('Grove on the River')).toBeNull();
});

test('a manual shift names its venue in the head', async () => {
  serve({ detail: payload([], { proposal_id: null, client_name: 'Night Market pop-up', event_type: null, location: 'Wicker Park' }) });
  mount();
  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText('Wicker Park')).toHaveClass('m-sheet-venue');
  expect(within(dialog).getByRole('heading')).toHaveTextContent('Night Market pop-up · Manual shift');
});

test('Approve with one open role sends that role, after re-reading the shift', async () => {
  serve({ detail: payload([onShift(1), onShift(2), reqRow(3)]) });
  const h = mount();
  tap(await screen.findByRole('button', { name: /Person 3/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(api.post).toHaveBeenCalledWith('/shifts/17/assign', { user_id: 103, position: 'Bartender' });
  // open read, pre-flight read, post-write read
  await waitFor(() => expect(detailReads().length).toBe(3));
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  // The re-read before the write is the network or an error, never a stored
  // copy: it is the one read that does not ask for the offline fallback.
  expect(liveReads()).toHaveLength(1);
  expect(offlineReads()).toHaveLength(2);
  expect(api.get.mock.invocationCallOrder[api.get.mock.calls.indexOf(liveReads()[0])])
    .toBeLessThan(api.post.mock.invocationCallOrder[0]);
});

test('with two open roles Approve sends nothing until a role row is tapped', async () => {
  serve({ detail: payload([reqRow(3, { requested_positions: '["Barback","Bartender"]' })], { positions_needed: TWO_ROLES }) });
  mount();
  tap(await screen.findByRole('button', { name: /Person 3/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText('Approve as')).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: /^Barback\s*1 open$/ }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/shifts/17/assign', { user_id: 103, position: 'Barback' }));
});

test('a waitlisted applicant picks the role even when only one is open', async () => {
  serve({ detail: payload([onShift(1, 'Bartender'), reqRow(2, { requested_positions: '["Bartender"]' })], { positions_needed: TWO_ROLES }) });
  mount();
  const r = await screen.findByRole('button', { name: /Person 2/ });
  expect(within(r).getByText('Waitlisted')).toBeInTheDocument();
  tap(r);
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText('Approve as')).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: /^Barback\s*1 open$/ }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/shifts/17/assign', { user_id: 102, position: 'Barback' }));
});

test('with no open role Approve is disabled, the picker is absent, and Deny still works', async () => {
  serve({ detail: payload([onShift(1), reqRow(2)], { positions_needed: '["Bartender"]' }) });
  mount();
  tap(await screen.findByRole('button', { name: /Person 2/ }));
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
  expect(screen.queryByPlaceholderText('Search active staff')).toBeNull();
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(api.post).not.toHaveBeenCalled();
});

test('Deny asks first, Keep backs out, and the confirm does not promise a notification', async () => {
  serve({ detail: payload([reqRow(3, { staff_name: 'Jo Ellis' })]) });
  const h = mount();
  tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  expect(screen.getByText('Deny Jo Ellis’s application? The request closes. They are not notified.')).toBeInTheDocument();
  expect(api.put).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: 'Keep' }));
  expect(screen.queryByText(/The request closes/)).toBeNull();
  expect(api.put).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: 'Deny' }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/shifts/requests/3', { status: 'denied' }));
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
});

test('a failed Deny or Remove stays inline with Retry, and Retry repeats that same write', async () => {
  serve({ detail: payload([onShift(1, 'Bartender', { staff_name: 'Lena Park' }), reqRow(3, { staff_name: 'Jo Ellis' })]) });
  api.put.mockRejectedValueOnce(NETWORK);
  api.delete.mockRejectedValueOnce({ status: 404, message: 'Request not found.' });
  const h = mount();
  tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  expect(await screen.findByText("No connection, didn't save.")).toBeInTheDocument();
  expect(h.onChanged).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
  expect(api.put).toHaveBeenLastCalledWith('/shifts/requests/3', { status: 'denied' });
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));

  tap(screen.getByRole('button', { name: /Lena Park/ }));
  tap(screen.getByRole('button', { name: 'Remove from shift' }));
  tap(screen.getByRole('button', { name: 'Remove' }));
  expect(await screen.findByText('Request not found.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  await waitFor(() => expect(detailReads().length).toBeGreaterThanOrEqual(3));
});

test('a failure box goes away when a different action is opened, so Retry can never repeat a stale write', async () => {
  serve({ detail: payload([reqRow(3, { staff_name: 'Jo Ellis' })]) });
  api.put.mockRejectedValueOnce(NETWORK);
  mount();
  tap(await screen.findByRole('button', { name: /Jo Ellis/ }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  tap(screen.getByRole('button', { name: 'Deny' }));
  expect(await screen.findByText("No connection, didn't save.")).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Deny' }));          // asks again
  expect(screen.queryByText("No connection, didn't save.")).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  tap(screen.getByRole('button', { name: 'Keep' }));
  expect(api.put).toHaveBeenCalledTimes(1);
});

test('Remove asks first and names payroll and the out-of-area lock', async () => {
  serve({ detail: payload([onShift(1, 'Bartender', { staff_name: 'Lena Park' })]) });
  const h = mount();
  tap(await screen.findByRole('button', { name: /Lena Park/ }));
  tap(screen.getByRole('button', { name: 'Remove from shift' }));
  expect(screen.getByText('Remove Lena Park from this shift? Payroll re-accrues and any out-of-area lock is released.')).toBeInTheDocument();
  expect(api.delete).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/shifts/requests/1'));
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
});

test('the picker is alphabetical, skips people already on the shift, and a tap on a person never assigns by itself', async () => {
  serve({ detail: payload([onShift(1)]) });
  mount();
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('Ana Flores');
  const names = within(dialog).getAllByText(/Ana Flores|Tess Marsh/).map((n) => n.textContent);
  expect(names).toEqual(['Ana Flores', 'Tess Marsh']);
  expect(within(dialog).getAllByText('Person 1').length).toBe(1);   // on the roster, not in the picker
  expect(within(row('Ana Flores')).getByText('33 events')).toBeInTheDocument();
  expect(within(row('Tess Marsh')).getByText('9 events · 8 mi')).toBeInTheDocument();
  tap(row('Tess Marsh'));
  expect(await screen.findByText('Assign as')).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: /^Bartender\s*2 open$/ }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/shifts/17/assign', { user_id: 9, position: 'Bartender' }));
});

test('a person just assigned says so on the roster', async () => {
  serve({ detail: [payload([]), payload([]), payload([onShift(9, 'Bartender', { user_id: 9, staff_name: 'Tess Marsh' })])] });
  mount();
  tap(await screen.findByRole('button', { name: /Tess Marsh/ }));
  tap(await screen.findByRole('button', { name: /^Bartender\s*3 open$/ }));
  expect(await screen.findByText('Bartender · just assigned')).toBeInTheDocument();
});

test('search narrows the picker and says when nothing matches', async () => {
  serve({ detail: payload([]) });
  mount();
  await screen.findByText('Ana Flores');
  const field = screen.getByPlaceholderText('Search active staff');
  expect(field).toHaveAttribute('type', 'search');
  fireEvent.change(field, { target: { value: 'tess' } });
  expect(screen.queryByText('Ana Flores')).toBeNull();
  expect(screen.getByText('Tess Marsh')).toBeInTheDocument();
  fireEvent.change(field, { target: { value: 'zzz' } });
  expect(screen.getByText('No active staff matches “zzz”.')).toBeInTheDocument();
});

test('a second tap while a write is in flight sends nothing', async () => {
  serve({ detail: payload([]) });
  api.post.mockReturnValue(new Promise(() => {}));   // the write never lands
  mount();
  tap(await screen.findByRole('button', { name: /Tess Marsh/ }));
  const role = await screen.findByRole('button', { name: /^Bartender\s*3 open$/ });
  tap(role);
  tap(role);
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  tap(role);
  tap(screen.getByRole('button', { name: /Ana Flores/ }));
  expect(api.post).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(role).toBeDisabled());
});

test('a role that filled since the sheet opened is refused before the write', async () => {
  serve({ detail: [
    payload([onShift(1), onShift(2), reqRow(3)]),
    payload([onShift(1), onShift(2), onShift(4, 'Bartender', { staff_name: 'Someone Else' }), reqRow(3)]),
  ] });
  const h = mount();
  tap(await screen.findByRole('button', { name: /Person 3/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText('The roster changed. Check the open roles and try again.')).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
  expect(h.onChanged).not.toHaveBeenCalled();
  expect(await screen.findByText('Someone Else')).toBeInTheDocument();
  expect(screen.getByText('3/3')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
});

test('a lost connection on the write keeps the row open and Retry repeats the same write', async () => {
  serve({ detail: payload([reqRow(3)]) });
  api.post.mockRejectedValueOnce(NETWORK);
  const h = mount();
  tap(await screen.findByRole('button', { name: /Person 3/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText("No connection, didn't save.")).toBeInTheDocument();
  expect(h.onChanged).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(api.post).toHaveBeenLastCalledWith('/shifts/17/assign', { user_id: 103, position: 'Bartender' });
  await waitFor(() => expect(h.onChanged).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("No connection, didn't save.")).toBeNull();
});

test('a server refusal shows the server message, inline', async () => {
  serve({ detail: payload([]) });
  api.post.mockRejectedValueOnce({ status: 404, message: 'User not eligible for assignment.' });
  mount();
  tap(await screen.findByRole('button', { name: /Tess Marsh/ }));
  tap(await screen.findByRole('button', { name: /^Bartender\s*3 open$/ }));
  expect(await screen.findByText('User not eligible for assignment.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
});

test('a re-read served from cache counts as no connection: nothing is written', async () => {
  serve({ detail: [payload([reqRow(3)]), payload([reqRow(3)], {}, { staleAt: '2026-09-29T17:00:00.000Z' })] });
  mount();
  tap(await screen.findByRole('button', { name: /Person 3/ }));
  tap(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText("No connection, didn't save.")).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
});

test('a cache-served roster is read-only: banner, no actions, picker offline, Retry re-reads', async () => {
  serve({ detail: [payload([onShift(1), reqRow(3)], {}, { staleAt: '2026-09-29T17:00:00.000Z' }), payload([onShift(1), reqRow(3)])] });
  mount();
  expect(await screen.findByText('No connection. Staffing actions need the server; the roster below is the cached copy.')).toBeInTheDocument();
  tap(screen.getByRole('button', { name: /Person 3/ }));
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
  tap(screen.getByRole('button', { name: /Person 1/ }));
  expect(screen.getByRole('button', { name: 'Remove from shift' })).toBeDisabled();
  expect(screen.getByPlaceholderText('Search active staff')).toBeDisabled();
  expect(within(row('Tess Marsh')).getByText('Offline')).toBeInTheDocument();
  expect(row('Tess Marsh')).toBeDisabled();
  tap(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByText(/the roster below is the cached copy/)).toBeNull());
  tap(screen.getByRole('button', { name: /Person 3/ }));
  expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
});

test('a finished shift is read-only and says so', async () => {
  serve({ detail: payload([onShift(1), reqRow(3)], { finished: true }) });
  mount();
  expect(await screen.findByText('Past event · roster is read-only')).toBeInTheDocument();
  tap(screen.getByRole('button', { name: /Person 1/ }));
  expect(screen.queryByRole('button', { name: 'Remove from shift' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(screen.queryByPlaceholderText('Search active staff')).toBeNull();
  expect(screen.queryByText('Bartender 1/3')).toBeNull();
});

test('a cancelled shift is read-only and says so', async () => {
  serve({ detail: payload([onShift(1)], { status: 'cancelled' }) });
  mount();
  expect(await screen.findByText('Cancelled · roster is read-only')).toBeInTheDocument();
  expect(screen.queryByPlaceholderText('Search active staff')).toBeNull();
});

test('a shift with no declared roles blocks approve and assign and points at the desktop view', async () => {
  serve({ detail: payload([onShift(1), reqRow(3)], { positions_needed: '[]' }) });
  mount();
  expect(await screen.findByText('No roles are declared on this shift. Staff it from desktop view.')).toBeInTheDocument();
  tap(screen.getByRole('button', { name: /Person 3/ }));
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
  expect(screen.queryByPlaceholderText('Search active staff')).toBeNull();
});

test('a dead shift read calls onDead, never onClose, and renders no roster', async () => {
  serve({ detail: { reject: { status: 404, message: 'Shift not found.' } } });
  const h = mount();
  await waitFor(() => expect(h.onDead).toHaveBeenCalledTimes(1));
  expect(h.onClose).not.toHaveBeenCalled();
});

test('a denied shift read without an onDead handler closes the sheet', async () => {
  serve({ detail: { reject: { status: 403, message: 'Staffing access required.' } } });
  const onClose = jest.fn();
  render(<AssignmentSheet shiftId={17} onClose={onClose} />);
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});

test('a failed first read offers Retry and recovers', async () => {
  serve({ detail: [{ reject: NETWORK }, payload([onShift(1, 'Bartender', { staff_name: 'Lena Park' })])] });
  mount();
  expect(await screen.findByText('Network error. Check your connection.')).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Lena Park')).toBeInTheDocument();
});

test('a picker that failed to load says so and the roster still works', async () => {
  serve({ detail: payload([onShift(1, 'Bartender', { staff_name: 'Lena Park' })]), staffFails: true });
  mount();
  expect(await screen.findByText('Lena Park')).toBeInTheDocument();
  expect(await screen.findByText("Couldn't load the staff list.")).toBeInTheDocument();
  expect(screen.queryByText(/No active staff matches/)).toBeNull();
  tap(screen.getByRole('button', { name: /Lena Park/ }));
  expect(screen.getByRole('button', { name: 'Remove from shift' })).toBeEnabled();
});

test('focusUserId opens that person, once', async () => {
  serve({ detail: payload([onShift(1), reqRow(3)]) });
  mount({ focusUserId: '103' });
  expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
  tap(screen.getByRole('button', { name: /Person 3/ }));   // collapse it
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull());
});

test('the scrim and Escape both close; the sheet itself does not', async () => {
  serve({ detail: payload([]) });
  const h = mount();
  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  tap(dialog);
  expect(h.onClose).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: 'Close' }));
  expect(h.onClose).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(h.onClose).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/mobile/AssignmentSheet.test.js`
Expected: FAIL, `Cannot find module './AssignmentSheet'`.

- [ ] **Step 3: Write the component**

Create `client/src/components/mobile/AssignmentSheet.js`:

```js
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../utils/api';
import { offlineGet } from '../../utils/offlineRead';
import Icon from '../adminos/Icon';
import StatusChip from '../adminos/StatusChip';
import { groupShiftRows, railParts } from '../../utils/eventCards';
import {
  buildShiftView, candidatesOf, roleStep, confirmCopy, READ_ONLY_NOTE,
} from '../../utils/staffingSheet';

// The phone ShiftDrawer for ONE shift (spec 2026-08-13-mobile-admin section 4
// Detail; benchmark docs/design-artifacts/2026-09-15-mobile-admin-shell.dc.html,
// Assignment sheet). Same endpoints and bodies as the desktop drawer:
//   approve / assign -> POST   /shifts/:id/assign          { user_id, position }
//   deny             -> PUT    /shifts/requests/:requestId { status: 'denied' }
//   remove           -> DELETE /shifts/requests/:requestId
//
// `position` keys payroll's tip split. It is always a role the screen showed
// before the tap (utils/staffingSheet.js roleStep), and the shift is re-read
// immediately before the write, because the server ACCEPTS an over-fill and
// the phone must not cause one from a roster that went stale while it was open.
//
// Reads. The roster and the picker are read with offlineGet: they may be
// answered from the phone's cache, and when they are (res.staleAt) every
// action is disabled. The re-read before a write is a plain api.get: it must
// be the network or an error, never a stored copy.
//
// Mounted only while open. The owner holds the URL state (useDrawerParam with
// push: true); this component never navigates.
const OFFLINE_SAVE = "No connection, didn't save.";
const OFFLINE_NOTE = 'No connection. Staffing actions need the server; the roster below is the cached copy.';
const ROSTER_MOVED = 'The roster changed. Check the open roles and try again.';
const LOAD_FAILED = 'Network error. Check your connection.';

const refusal = (status, message) => Object.assign(new Error(message), { status });
const isTransport = (err) => !err || err.status === 0 || err.code === 'NETWORK_ERROR';

export default function AssignmentSheet({ shiftId, focusUserId = null, onClose, onChanged, onDead }) {
  const [data, setData] = useState(null);           // { shift, requests }
  const [staleAt, setStaleAt] = useState(null);     // set when the service worker served the read
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [staff, setStaff] = useState([]);
  const [staffError, setStaffError] = useState(false);
  const [focusKey, setFocusKey] = useState(null);   // the expanded roster row
  const [pickKey, setPickKey] = useState(null);     // the row showing its role rows
  const [confirm, setConfirm] = useState(null);     // { key, kind: 'remove' | 'deny' }
  const [failure, setFailure] = useState(null);     // { key, message }
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [justAssigned, setJustAssigned] = useState([]);

  const busyRef = useRef(false);      // the synchronous half of `busy`: a second tap lands before a render
  const retryRef = useRef(null);      // the write the failure box repeats
  const seq = useRef(0);
  const sheetRef = useRef(null);
  const focusedOnce = useRef(false);
  const handlers = useRef({ onClose, onChanged, onDead });
  handlers.current = { onClose, onChanged, onDead };

  const load = useCallback(async ({ quiet = false } = {}) => {
    const mine = ++seq.current;
    if (!quiet) { setLoading(true); setLoadError(null); }
    try {
      const res = await offlineGet(`/shifts/detail/${shiftId}`);
      if (mine !== seq.current) return;
      setData(res.data || null);
      setStaleAt(res.staleAt || null);
    } catch (err) {
      if (mine !== seq.current) return;
      // Dead shift (deleted, or staffing access lost): the owner decides where
      // to land. Never render an error screen over a route that cannot recover.
      if (err && (err.status === 404 || err.status === 403)) {
        const h = handlers.current;
        if (h.onDead) h.onDead(); else if (h.onClose) h.onClose();
        return;
      }
      if (!quiet) setLoadError((err && err.message) || LOAD_FAILED);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [shiftId]);

  const loadStaff = useCallback(async () => {
    setStaffError(false);
    try {
      const res = await offlineGet('/admin/active-staff', { params: { limit: 100, shift_id: shiftId } });
      setStaff((res.data && res.data.staff) || []);
    } catch {
      setStaffError(true);
    }
  }, [shiftId]);

  useEffect(() => { load(); loadStaff(); }, [load, loadStaff]);

  // Focus moves into the sheet and returns to the opener; Escape closes.
  useEffect(() => {
    const opener = document.activeElement;
    if (sheetRef.current) sheetRef.current.focus();
    const onKey = (e) => { if (e.key === 'Escape' && handlers.current.onClose) handlers.current.onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && typeof opener.focus === 'function') opener.focus();
    };
  }, []);

  const view = useMemo(
    () => buildShiftView(data && data.shift, data && data.requests, { justAssigned }),
    [data, justAssigned]
  );
  const card = useMemo(() => (data && data.shift ? groupShiftRows([data.shift])[0] : null), [data]);
  const candidates = useMemo(() => candidatesOf(staff, view, query), [staff, view, query]);

  useEffect(() => {
    if (focusedOnce.current || focusUserId === null || focusUserId === undefined || view.rows.length === 0) return;
    focusedOnce.current = true;
    const target = view.rows.find((r) => String(r.userId) === String(focusUserId));
    if (target) setFocusKey(target.key);
  }, [focusUserId, view.rows]);

  const offline = !!staleAt;
  const closed = !!view.closedReason;
  const locked = offline || closed;          // no write is possible
  const canAssign = !closed && !view.rosterless && view.openRoles.length > 0;

  const run = useCallback(async (key, write) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    retryRef.current = write;
    try {
      await write();
      setConfirm(null);
      setPickKey(null);
      await load({ quiet: true });
      loadStaff();
      if (handlers.current.onChanged) handlers.current.onChanged();
    } catch (err) {
      const transport = isTransport(err);
      setConfirm(null);
      setFailure({ key, message: transport ? OFFLINE_SAVE : ((err && err.message) || 'Something went wrong. Try again.') });
      // A server refusal means the roster moved under us: show the truth.
      if (!transport) load({ quiet: true });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [load, loadStaff]);

  // Approve and assign share one write. The re-read is the over-fill guard.
  const place = (key, userId, role) => run(key, async () => {
    const fresh = await api.get(`/shifts/detail/${shiftId}`);
    if (fresh.staleAt) throw refusal(0, OFFLINE_SAVE);
    const now = buildShiftView(fresh.data && fresh.data.shift, fresh.data && fresh.data.requests);
    if (now.closedReason || !now.openRoles.some((r) => r.role === role)) {
      setData(fresh.data || null);
      throw refusal(409, ROSTER_MOVED);
    }
    await api.post(`/shifts/${shiftId}/assign`, { user_id: userId, position: role });
    setJustAssigned((prev) => (prev.includes(userId) ? prev : prev.concat(userId)));
  });
  const deny = (row) => run(row.key, () => api.put(`/shifts/requests/${row.requestId}`, { status: 'denied' }));
  const remove = (row) => run(row.key, () => api.delete(`/shifts/requests/${row.requestId}`));

  const toggleFocus = (key) => {
    setFocusKey((cur) => (cur === key ? null : key));
    setPickKey(null);
    setConfirm(null);
    setFailure(null);
  };
  // Opening a different intent drops the failure box: its Retry repeats the
  // write that failed, and that must never be a write the screen has moved on
  // from (a failed Deny, then Approve, then Retry sending the Deny).
  const onApprove = (row) => {
    const step = roleStep(view, row);
    setFailure(null);
    if (step.kind === 'direct') place(row.key, row.userId, step.role);
    else if (step.kind === 'pick') setPickKey((cur) => (cur === row.key ? null : row.key));
  };
  const ask = (row, kind) => {
    setFailure(null);
    setPickKey(null);
    setConfirm({ key: row.key, kind });
  };
  const onCandidate = (c) => {
    setFailure(null);
    setFocusKey(null);
    setPickKey((cur) => (cur === c.key ? null : c.key));
  };

  const failBox = (key) => (failure && failure.key === key ? (
    <div className="m-fail" role="alert">
      <span className="m-fail-msg">{failure.message}</span>
      <button type="button" className="m-fail-retry" disabled={busy}
        onClick={() => retryRef.current && run(key, retryRef.current)}>Retry</button>
    </div>
  ) : null);

  const roleRows = (label, person) => (
    <>
      <div className="m-role-label">{label}</div>
      {view.openRoles.map((r) => (
        <button key={r.role} type="button" className="m-sheet-row" disabled={busy || locked}
          onClick={() => place(person.key, person.userId, r.role)}>
          <span className="m-role-name">{r.role}</span>
          <span className="m-role-open">{r.open} open</span>
        </button>
      ))}
    </>
  );

  const renderRosterRow = (row) => {
    const focused = focusKey === row.key && !closed;
    const step = roleStep(view, row);
    const asking = focused && confirm && confirm.key === row.key ? confirmCopy(confirm.kind, row.name) : null;
    return (
      <div className="m-sheet-item" key={row.key}>
        <button type="button" className="m-sheet-row m-person" aria-expanded={focused}
          onClick={() => toggleFocus(row.key)}>
          <span className={`m-avatar${row.kind === 'rostered' ? '' : ' m-avatar-app'}`} aria-hidden="true">{row.initials}</span>
          <span className="m-person-main">
            <span className="m-person-name">{row.name}</span>
            {row.meta ? <span className="m-person-meta">{row.meta}</span> : null}
          </span>
          {row.kind === 'applicant' && <StatusChip kind="warn">Pending</StatusChip>}
          {row.kind === 'waitlisted' && <StatusChip kind="neutral">Waitlisted</StatusChip>}
          {row.kind === 'rostered' && <span className="m-person-check"><Icon name="check" size={16} /></span>}
        </button>
        {focused && asking && (
          <div className="m-confirm">
            <span className="m-confirm-copy">{asking.copy}</span>
            <span className="m-confirm-btns">
              <button type="button" className="m-act m-act-quiet" disabled={busy} onClick={() => setConfirm(null)}>Keep</button>
              <button type="button" className="m-act m-act-confirm" disabled={busy || offline}
                onClick={() => (confirm.kind === 'remove' ? remove(row) : deny(row))}>{asking.label}</button>
            </span>
          </div>
        )}
        {focused && !asking && (
          <div className="m-acts">
            {row.kind === 'rostered' ? (
              <button type="button" className="m-act m-act-danger" disabled={busy || offline}
                onClick={() => ask(row, 'remove')}>Remove from shift</button>
            ) : (
              <>
                <button type="button" className="m-act m-act-primary"
                  disabled={busy || offline || step.kind === 'blocked'}
                  onClick={() => onApprove(row)}>Approve</button>
                <button type="button" className="m-act m-act-quiet" disabled={busy || offline}
                  onClick={() => ask(row, 'deny')}>Deny</button>
              </>
            )}
          </div>
        )}
        {focused && !asking && pickKey === row.key && step.kind === 'pick' && roleRows('Approve as', row)}
        {focused && failBox(row.key)}
      </div>
    );
  };

  const renderCandidate = (c) => (
    <div className="m-sheet-item" key={c.key}>
      <button type="button" className="m-sheet-row m-person" aria-expanded={pickKey === c.key}
        disabled={busy || offline} onClick={() => onCandidate(c)}>
        <span className="m-avatar" aria-hidden="true">{c.initials}</span>
        <span className="m-person-main">
          <span className="m-person-name">{c.name}</span>
          {c.meta ? <span className="m-person-meta">{c.meta}</span> : null}
        </span>
        <span className={`m-person-go${offline ? ' m-person-go-off' : ''}`}>{offline ? 'Offline' : 'Assign'}</span>
      </button>
      {pickKey === c.key && !offline && roleRows('Assign as', c)}
      {failBox(c.key)}
    </div>
  );

  const rail = card && card.ymd ? railParts(card.ymd) : null;
  const when = card ? [rail ? `${rail.dow} ${rail.mon} ${rail.day}` : '', card.timeRange].filter(Boolean).join(' · ') : '';
  const rowKeys = view.rows.map((r) => r.key).concat(candidates.map((c) => c.key));
  const strayFailure = failure && !rowKeys.includes(failure.key) ? failure.key : null;

  return (
    <>
      <button type="button" className="m-sheet-scrim" aria-label="Close" tabIndex={-1}
        onClick={() => handlers.current.onClose && handlers.current.onClose()} />
      <div className="m-sheet" role="dialog" aria-modal="true" aria-label="Assign staff" tabIndex={-1} ref={sheetRef}>
        <div className="m-sheet-handle" />
        {card && (
          <div className="m-sheet-head">
            <h2 className="m-sheet-title">
              {card.clientName}
              {card.kind ? <span className="m-sheet-kind">{` · ${card.kind}`}</span> : null}
            </h2>
            <div className="m-sheet-when">
              <span>{when}</span>
              <span className="m-pills">
                {view.pills.map((p, i) => (
                  <span key={i} className={`m-pill${p === 'filled' ? ' m-pill-filled' : p === 'pending' ? ' m-pill-pending' : ''}`} />
                ))}
                {view.closedReason === 'cancelled' ? null : <span className="m-pill-count">{view.count}</span>}
              </span>
            </div>
            <div className="m-sheet-mix">{closed ? READ_ONLY_NOTE[view.closedReason] : view.mix}</div>
            {card.manual && card.venue ? <div className="m-sheet-venue">{card.venue}</div> : null}
          </div>
        )}
        <div className="m-sheet-body">
          {loading && !data && <div className="m-sheet-state">Loading the roster</div>}
          {loadError && !data && (
            <div className="m-fail" role="alert">
              <span className="m-fail-msg">{loadError}</span>
              <button type="button" className="m-fail-retry" onClick={() => load()}>Retry</button>
            </div>
          )}
          {data && (
            <>
              {offline && !closed && (
                <div className="m-sheet-note">
                  <span className="m-sheet-note-dot" aria-hidden="true" />
                  <span className="m-sheet-note-text">{OFFLINE_NOTE}</span>
                  <button type="button" className="m-fail-retry" onClick={() => { load(); loadStaff(); }}>Retry</button>
                </div>
              )}
              {view.rosterless && !closed && (
                <div className="m-sheet-note">
                  <span className="m-sheet-note-dot" aria-hidden="true" />
                  <span className="m-sheet-note-text">{READ_ONLY_NOTE.rosterless}</span>
                </div>
              )}
              {strayFailure && failBox(strayFailure)}
              {view.rows.length > 0 && (
                <>
                  <div className="m-sheet-sec">On this shift</div>
                  {view.rows.map(renderRosterRow)}
                </>
              )}
              {canAssign && (
                <>
                  <div className={`m-sheet-sec${view.rows.length > 0 ? ' m-sheet-sec-line' : ''}`}>{`Assign · ${view.openLabel}`}</div>
                  <div className="m-sheet-searchwrap">
                    <input type="search" className="m-sheet-search" placeholder="Search active staff"
                      aria-label="Search active staff" value={query} disabled={offline}
                      onChange={(e) => { setQuery(e.target.value); setPickKey(null); }} />
                  </div>
                  {staffError ? (
                    <div className="m-fail" role="alert">
                      <span className="m-fail-msg">Couldn't load the staff list.</span>
                      <button type="button" className="m-fail-retry" onClick={loadStaff}>Retry</button>
                    </div>
                  ) : (
                    <>
                      {candidates.map(renderCandidate)}
                      {candidates.length === 0 && (
                        <div className="m-sheet-nomatch">
                          {query.trim() ? `No active staff matches “${query.trim()}”.` : 'Everyone active is already on this shift.'}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/mobile/AssignmentSheet.test.js`
Expected: PASS, 28 tests, and no "not wrapped in act(...)" warning in the output (the suite ran clean in a scratch copy, 2026-09-29; the one `ReactDOMTestUtils.act is deprecated` line is library noise every suite prints). If a warning names a state update after a test returned, that test is missing an `await` on the last effect it triggers; fix the test, never silence the warning.

- [ ] **Step 5: Check the file size and build**

Run: `wc -l client/src/components/mobile/AssignmentSheet.js && cd client && CI=true npx react-scripts build`
Expected: about 370 lines, under the 400 in Global Constraints; the build exits 0 (its one warning, a missing source map inside the `html2pdf.js` package, predates this lane and is not an ESLint warning).

- [ ] **Step 6: Commit**

```bash
git add client/src/components/mobile/AssignmentSheet.js client/src/components/mobile/AssignmentSheet.test.js && git commit -F - <<'MSG'
feat(phone staffing): the assignment sheet

The phone ShiftDrawer for one shift: roster with inline Approve, Deny and
Remove behind confirms, role rows, the alphabetical active-staff picker with
search, seniority and distance as plain meta. Same endpoints and bodies as
the desktop drawer. The shift is re-read before an approve or an assign so
the phone cannot over-fill from a roster that went stale. One write at a
time. Failures stay inline with Retry. A cache-served, finished or cancelled
roster is read-only.
MSG
```

---
### Task 7: Pure event-detail view-model: header, contacts, staffing groups, financials

**Files:**
- Create: `client/src/utils/eventDetailView.js`
- Test: `client/src/utils/eventDetailView.test.js`

**Interfaces:**
- Consumes: `buildShiftView` from Task 4; `railParts` from `client/src/utils/eventCards.js`; `fmtTimeRange24, fmtTime24, fmt$2dp, fmt$fromCents, fmtDate, dayDiff` from `client/src/components/adminos/format.js`; `getEventTypeLabel` from `client/src/utils/eventTypes.js`; `venueMapQuery` from `client/src/components/VenueAddressFields.js`; `resolveGratuityDisplayLabel` from `client/src/utils/gratuityLabels.js`; `formatPhone` from `client/src/utils/formatPhone.js`. Response shapes: `GET /proposals/:id`, `GET /shifts/by-proposal/:id` (Task 1), `GET /drink-plans/by-proposal/:id?fields=day_of_contact` (Task 3b: `{ day_of_contact: { name, phone } | null }`), `GET /invoices/proposal/:id`.
- Produces, for Task 8b:
  - `headerOf(proposal) -> { title, kind, guests, venue, mapHref }` (the object `MobileHeader` renders; `mapHref` is `null` when there is no location)
  - `whenOf(proposal, { todayYmd } = {}) -> { text, isToday }`
  - `setupOf(proposal) -> string | null` ("from 17:15 · 45 min before")
  - `contactsOf(proposal, dayOf) -> { summary, client: { phone, telHref, smsHref, email, mailHref }, dayOf: { name, phone, telHref, smsHref } | null }`. `dayOf` is the body of the day-of-contact projection; the full drink plan shape is NOT read (a test pins that). Both `phone` values are FORMATTED for display ("(312) 555-0142") whatever shape was stored; the hrefs carry the dialable digits.
  - `staffingOf(shifts, proposal) -> { count, state: 'open' | 'full' | 'closed', groups: [{ shiftId, showHead, label, view }] }` where `view` is Task 4's `ShiftView`
  - `financialsOf(proposal, invoicesPayload) -> { lines: [{ label, amount }], total, payments: [{ key, label, sub, amount }] | null, pending: [{ key, label, sub, amount }], balance: { amount, sub, inFlight } | null, paidInFull, paidToDate, chip: { kind, label } }`
  - `earliestStale(...stamps) -> string | null`

- [ ] **Step 1: Write the failing test**

Create `client/src/utils/eventDetailView.test.js`:

```js
import '@testing-library/jest-dom';
import {
  headerOf, whenOf, setupOf, contactsOf, staffingOf, financialsOf, earliestStale,
} from './eventDetailView';
import { railParts } from './eventCards';

const proposal = (over = {}) => ({
  id: 13, status: 'deposit_paid', client_name: 'Alexis Henderson', client_phone: '3125550184',
  client_email: 'alexis.hend@gmail.com', event_type: 'wedding-reception', event_type_custom: null,
  event_date: '2999-08-15T00:00:00.000Z', event_start_time: '18:00', event_duration_hours: '5',
  event_location: 'Grove on the River, 12 River Rd, Rockford, Illinois 61101',
  venue_street: '12 River Rd', venue_city: 'Rockford', venue_state: 'Illinois', venue_zip: '61101',
  guest_count: 140, setup_time_display: '17:15', setup_minutes_before: null,
  total_price: '3650.00', amount_paid: '1900.00', balance_due_date: '2999-08-08',
  package_name: 'Signature bar',
  pricing_snapshot: { total: 3650, breakdown: [
    { label: 'Signature bar', amount: 2800 },
    { label: 'Mobile bar rental', amount: 450 },
    { label: 'Loyalty discount', amount: -50 },
    { label: 'Champagne service', amount: 450.5 },
  ] },
  ...over,
});
const shift = (id, over = {}) => ({
  id, status: 'open', finished: false, event_date: '2999-08-15', start_time: '18:00',
  positions_needed: '["Bartender","Bartender"]', requesters: [], ...over,
});
const person = (id, over = {}) => ({
  request_id: id, user_id: 100 + id, name: `Person ${id}`, status: 'approved', position: 'Bartender',
  dropped_at: null, requested_positions: '["Bartender"]', home_distance_miles: 2.4, events_worked: 87, ...over,
});

describe('headerOf', () => {
  test('client, kind, guests, venue and an address-only map query', () => {
    expect(headerOf(proposal())).toEqual({
      title: 'Alexis Henderson',
      kind: 'Wedding Reception',
      guests: 140,
      venue: 'Grove on the River, 12 River Rd, Rockford, Illinois 61101',
      mapHref: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('12 River Rd, Rockford, Illinois 61101')}`,
    });
  });
  test('a legacy free-text location is its own map query', () => {
    const h = headerOf(proposal({ venue_street: null, venue_city: null, venue_state: null, venue_zip: null, event_location: 'The Whistler' }));
    expect(h.mapHref).toBe(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('The Whistler')}`);
  });
  test('no location, no link; no name, a plain title; no guests, null', () => {
    const h = headerOf(proposal({ event_location: '  ', venue_street: null, client_name: null, guest_count: null }));
    expect(h).toMatchObject({ title: 'Event', venue: '', mapHref: null, guests: null });
  });
});

describe('whenOf', () => {
  const rail = railParts('2999-08-15');
  test('date and the 24h range with its duration', () => {
    expect(whenOf(proposal(), { todayYmd: '2999-08-01' })).toEqual({ text: `${rail.dow} ${rail.mon} ${rail.day} · 18:00–23:00 · 5h`, isToday: false });
  });
  test('today is flagged by the Chicago day the caller passes', () => {
    expect(whenOf(proposal(), { todayYmd: '2999-08-15' }).isToday).toBe(true);
  });
  test('another year says so, because the rail has no year', () => {
    expect(whenOf(proposal(), { todayYmd: '2998-12-30' }).text).toBe(`${rail.dow} ${rail.mon} ${rail.day} 2999 · 18:00–23:00 · 5h`);
  });
  test('no start time leaves the date alone; no date leaves the time alone; neither is empty', () => {
    expect(whenOf(proposal({ event_start_time: null }), { todayYmd: '2999-08-01' }).text).toBe(`${rail.dow} ${rail.mon} ${rail.day}`);
    expect(whenOf(proposal({ event_date: null }), { todayYmd: '2999-08-01' })).toEqual({ text: '18:00–23:00 · 5h', isToday: false });
    expect(whenOf(proposal({ event_date: null, event_start_time: null })).text).toBe('');
  });
});

describe('setupOf', () => {
  test('the server clock time plus how long before service that is', () => {
    expect(setupOf(proposal())).toBe('from 17:15 · 45 min before');
    expect(setupOf(proposal({ setup_time_display: '16:30' }))).toBe('from 16:30 · 90 min before');
  });
  test('a 12h start time still yields the gap', () => {
    expect(setupOf(proposal({ event_start_time: '6:00 PM', setup_time_display: '17:00' }))).toBe('from 17:00 · 60 min before');
  });
  test('setup before midnight for a service after it', () => {
    expect(setupOf(proposal({ event_start_time: '00:30', setup_time_display: '23:30' }))).toBe('from 23:30 · 60 min before');
  });
  test('no setup time, no line; an unreadable start, the time alone', () => {
    expect(setupOf(proposal({ setup_time_display: null }))).toBeNull();
    expect(setupOf(proposal({ event_start_time: 'evening' }))).toBe('from 17:15');
  });
});

describe('contactsOf', () => {
  const dayOf = (name, phone) => ({ day_of_contact: { name, phone } });

  test('client phone and email become tap targets', () => {
    const c = contactsOf(proposal(), null);
    expect(c.client).toEqual({
      phone: '(312) 555-0184', telHref: 'tel:3125550184', smsHref: 'sms:3125550184',
      email: 'alexis.hend@gmail.com', mailHref: 'mailto:alexis.hend@gmail.com',
    });
    expect(c.dayOf).toBeNull();
    expect(c.summary).toBe('day-of pending');
  });
  test('the day-of contact comes from the projection, name and phone only', () => {
    const c = contactsOf(proposal(), dayOf(' Marcus Keller ', '(312) 555-0142'));
    expect(c.dayOf).toEqual({ name: 'Marcus Keller', phone: '(312) 555-0142', telHref: 'tel:3125550142', smsHref: 'sms:3125550142' });
    expect(c.summary).toBe('day-of set');
  });
  test('a day-of phone stored as bare digits is shown formatted, like the client number', () => {
    const c = contactsOf(proposal(), dayOf('Marcus Keller', '3125550142'));
    expect(c.dayOf).toEqual({ name: 'Marcus Keller', phone: '(312) 555-0142', telHref: 'tel:3125550142', smsHref: 'sms:3125550142' });
  });
  test('a day-of contact with a name and no phone has no links', () => {
    const c = contactsOf(proposal(), dayOf('Priya Shah', ''));
    expect(c.dayOf).toEqual({ name: 'Priya Shah', phone: '', telHref: null, smsHref: null });
  });
  test('an empty name means no day-of contact, whatever else is there', () => {
    for (const body of [
      dayOf('  ', '3125550142'), dayOf(null, '3125550142'), { day_of_contact: null }, { day_of_contact: 'Marcus' },
      {}, null, undefined, 'a string',
    ]) expect(contactsOf(proposal(), body).dayOf).toBeNull();
  });
  test('the full drink plan shape is NOT read: the phone takes the projection or nothing', () => {
    const fullPlan = { token: 'secret', admin_notes: 'x', selections: { logistics: { dayOfContact: { name: 'Marcus Keller', phone: '3125550142' }, accessNotes: 'gate 4471' } } };
    expect(contactsOf(proposal(), fullPlan).dayOf).toBeNull();
  });
  test('an international number keeps its plus; a client with nothing on file has no links', () => {
    expect(contactsOf(proposal({ client_phone: '+44 20 7946 0958' }), null).client.telHref).toBe('tel:+442079460958');
    expect(contactsOf(proposal({ client_phone: null, client_email: null }), null).client)
      .toEqual({ phone: '', telHref: null, smsHref: null, email: '', mailHref: null });
  });
});

describe('staffingOf', () => {
  test('one shift: no head, the event fraction, open', () => {
    const s = staffingOf([shift(1, { requesters: [person(1)] })], proposal());
    expect(s.count).toBe('1/2');
    expect(s.state).toBe('open');
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]).toMatchObject({ shiftId: 1, showHead: false });
    expect(s.groups[0].view.rows.map((r) => r.name)).toEqual(['Person 1']);
  });
  test('two shifts on one day: a head each, told apart by time and roles', () => {
    const s = staffingOf([
      shift(1, { start_time: '16:00', positions_needed: '["Bartender","Bartender","Bartender"]', requesters: [person(1), person(2), person(3)] }),
      shift(2, { start_time: '17:00', positions_needed: '["Banquet Server"]', requesters: [] }),
    ], proposal());
    expect(s.groups.map((g) => [g.showHead, g.label])).toEqual([[true, '16:00 · Bartenders'], [true, '17:00 · Banquet Servers']]);
    expect(s.count).toBe('3/4');
    expect(s.state).toBe('open');
  });
  test('two shifts on two days carry the date in the head', () => {
    const a = railParts('2999-08-15'); const b = railParts('2999-08-16');
    const s = staffingOf([shift(1), shift(2, { event_date: '2999-08-16T00:00:00.000Z' })], proposal());
    expect(s.groups.map((g) => g.label)).toEqual([
      `${a.dow} ${a.mon} ${a.day} · 18:00 · Bartenders`, `${b.dow} ${b.mon} ${b.day} · 18:00 · Bartenders`,
    ]);
  });
  test('fully staffed', () => {
    expect(staffingOf([shift(1, { requesters: [person(1), person(2)] })], proposal())).toMatchObject({ count: '2/2', state: 'full' });
  });
  test('an archived proposal closes every shift and shows no fraction', () => {
    const s = staffingOf([shift(1, { requesters: [person(1)] })], proposal({ status: 'archived' }));
    expect(s).toMatchObject({ count: '', state: 'closed' });
    expect(s.groups[0].view.closedReason).toBe('cancelled');
  });
  test('a finished event is closed and keeps its fraction', () => {
    expect(staffingOf([shift(1, { finished: true, requesters: [person(1)] })], proposal())).toMatchObject({ count: '1/2', state: 'closed' });
  });
  test('no shifts and a missing list are empty, not errors', () => {
    expect(staffingOf([], proposal())).toEqual({ count: '', state: 'open', groups: [] });
    expect(staffingOf(null, proposal())).toEqual({ count: '', state: 'open', groups: [] });
  });
});

describe('financialsOf', () => {
  const invoices = (list, pending = []) => ({ invoices: list, pending_payments: pending });
  const inv = (id, over = {}) => ({ id, invoice_number: `INV-0${id}`, label: 'Deposit', amount_due: 10000, amount_paid: 10000, status: 'paid', due_date: null, ...over });

  test('lines from the snapshot, to the cent, a discount as a negative', () => {
    const f = financialsOf(proposal(), invoices([]));
    expect(f.lines).toEqual([
      { label: 'Signature bar', amount: '$2,800.00' },
      { label: 'Mobile bar rental', amount: '$450.00' },
      { label: 'Loyalty discount', amount: `${String.fromCharCode(0x2212)}$50.00` },
      { label: 'Champagne service', amount: '$450.50' },
    ]);
    expect(f.total).toBe('$3,650.00');
  });

  test('the total is the proposal row, not the snapshot, when they disagree', () => {
    expect(financialsOf(proposal({ total_price: '3700.00' }), invoices([])).total).toBe('$3,700.00');
  });

  test('a proposal with no pricing snapshot still renders a total', () => {
    for (const snap of [null, undefined, {}, { breakdown: [] }, 'not json']) {
      const f = financialsOf(proposal({ pricing_snapshot: snap }), invoices([]));
      expect(f.lines).toEqual([{ label: 'Signature bar', amount: '$3,650.00' }]);
      expect(f.total).toBe('$3,650.00');
    }
    expect(financialsOf(proposal({ pricing_snapshot: null, package_name: null }), invoices([])).lines[0].label).toBe('Package');
  });

  test('a snapshot that arrives as a JSON string is read', () => {
    const f = financialsOf(proposal({ pricing_snapshot: JSON.stringify({ breakdown: [{ label: 'Classic bar', amount: 1600 }] }) }), invoices([]));
    expect(f.lines).toEqual([{ label: 'Classic bar', amount: '$1,600.00' }]);
  });

  test('payments are the invoices that took money, in cents, void ones skipped', () => {
    const f = financialsOf(proposal(), invoices([
      inv(1),
      inv(2, { label: 'Balance 1 of 2', amount_due: 355000, amount_paid: 180000, status: 'partially_paid' }),
      inv(3, { label: 'Balance 2 of 2', amount_due: 175000, amount_paid: 0, status: 'sent' }),
      inv(4, { label: 'Voided', amount_paid: 5000, status: 'void' }),
    ]));
    expect(f.payments).toEqual([
      { key: 'i1', label: 'Deposit', sub: 'paid', amount: '$100.00' },
      { key: 'i2', label: 'Balance 1 of 2', sub: 'part paid · $1,800.00 of $3,550.00', amount: '$1,800.00' },
    ]);
  });

  test('a balance shows what is owed and when', () => {
    const f = financialsOf(proposal(), invoices([inv(1)]));
    expect(f.balance).toEqual({ amount: '$1,750.00', sub: 'due AUG 8', inFlight: false });
    expect(f.paidInFull).toBe(false);
    expect(f.paidToDate).toBe('$1,900.00');
    expect(f.chip).toEqual({ kind: 'warn', label: 'Balance due' });
  });

  test('no due date says so', () => {
    expect(financialsOf(proposal({ balance_due_date: null }), invoices([])).balance.sub).toBe('due date not set');
  });

  test('paid in full needs a paid status AND no balance, like the desktop panel', () => {
    const paid = financialsOf(proposal({ status: 'balance_paid', amount_paid: '3650.00' }), invoices([inv(1)]));
    expect(paid).toMatchObject({ paidInFull: true, balance: null, chip: { kind: 'ok', label: 'Paid' } });
    // A refund can leave a confirmed event with money owed again.
    const refunded = financialsOf(proposal({ status: 'confirmed', amount_paid: '3000.00' }), invoices([]));
    expect(refunded).toMatchObject({ paidInFull: false, chip: { kind: 'warn', label: 'Balance due' } });
    expect(refunded.balance.amount).toBe('$650.00');
    // Nothing owed, but not a paid status: say only what is true.
    const odd = financialsOf(proposal({ status: 'deposit_paid', amount_paid: '3650.00' }), invoices([]));
    expect(odd).toMatchObject({ paidInFull: false, balance: null, chip: { kind: 'neutral', label: 'No balance' } });
  });

  test('a payment in flight wins the chip and marks the balance', () => {
    const f = financialsOf(proposal(), invoices([inv(1)], [
      { amount_cents: 175000, started_at: '2999-08-05T15:00:00.000Z', invoice_id: 2, invoice_number: 'INV-0363' },
    ]));
    expect(f.chip).toEqual({ kind: 'info', label: 'Processing' });
    expect(f.pending).toHaveLength(1);
    expect(f.pending[0]).toMatchObject({ key: 'p0', label: 'Bank payment processing', amount: '$1,750.00' });
    expect(f.pending[0].sub).toMatch(/^started [A-Z]{3} \d{1,2} · INV-0363$/);
    expect(f.balance).toMatchObject({ amount: '$1,750.00', inFlight: true });
    expect(f.balance.sub).toBe('due AUG 8 · bank payment in flight');
  });

  test('bad money and bad dates never render a dash glyph', () => {
    const f = financialsOf(
      proposal({ balance_due_date: 'soon', pricing_snapshot: { breakdown: [{ label: 'Odd line', amount: 'n/a' }] } }),
      invoices([inv(1, { amount_due: null, amount_paid: 5000, status: 'partially_paid' })], [{ amount_cents: null, started_at: null, invoice_number: null }])
    );
    expect(JSON.stringify(f).includes(String.fromCharCode(0x2014))).toBe(false);
    expect(f.balance.sub).toBe('due date not set · bank payment in flight');
    expect(f.lines).toEqual([{ label: 'Odd line', amount: '$0.00' }]);
    expect(f.pending[0].amount).toBe('$0.00');
  });

  test('a payment in flight with no invoice number and no readable date still renders', () => {
    const f = financialsOf(proposal(), invoices([], [{ amount_cents: 40000, started_at: 'nonsense', invoice_id: null, invoice_number: null }]));
    expect(f.pending[0]).toEqual({ key: 'p0', label: 'Bank payment processing', sub: '', amount: '$400.00' });
  });

  test('the invoices read being unavailable is not "no payments"', () => {
    for (const payload of [null, undefined, {}]) {
      const f = financialsOf(proposal(), payload);
      expect(f.payments).toBeNull();
      expect(f.pending).toEqual([]);
      expect(f.paidToDate).toBe('$1,900.00');
      expect(f.chip).toEqual({ kind: 'warn', label: 'Balance due' });
    }
  });

  test('an archived event reads Cancelled whatever the money says', () => {
    expect(financialsOf(proposal({ status: 'archived' }), invoices([])).chip).toEqual({ kind: 'neutral', label: 'Cancelled' });
  });
});

test('earliestStale returns the oldest stamp among the cache-served reads', () => {
  expect(earliestStale(null, undefined)).toBeNull();
  expect(earliestStale('2026-09-29T17:00:00.000Z')).toBe('2026-09-29T17:00:00.000Z');
  expect(earliestStale('2026-09-29T17:00:00.000Z', null, '2026-09-29T15:30:00.000Z')).toBe('2026-09-29T15:30:00.000Z');
  expect(earliestStale('garbage', '2026-09-29T15:30:00.000Z')).toBe('2026-09-29T15:30:00.000Z');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/eventDetailView.test.js`
Expected: FAIL, `Cannot find module './eventDetailView'`.

- [ ] **Step 3: Write the module**

Create `client/src/utils/eventDetailView.js`:

```js
// Pure view-model for the phone event detail (spec 2026-08-13-mobile-admin
// section 4 Detail, benchmark 2026-09-15). No React, no fetch. Everything the
// screen shows is derived here from the four reads, so the rules are tested
// without rendering.
//
// MONEY. Nothing here computes a price. The lines are the stored pricing
// snapshot, the total and the amount paid are the proposal row, and "balance"
// and "paid in full" follow ProposalDetailPaymentPanel exactly, so the phone
// and the desktop can never show two different figures for one event.
import { railParts } from './eventCards';
import { getEventTypeLabel } from './eventTypes';
import { resolveGratuityDisplayLabel } from './gratuityLabels';
import { formatPhone } from './formatPhone';
import { buildShiftView } from './staffingSheet';
import { venueMapQuery } from '../components/VenueAddressFields';
import { fmtTimeRange24, fmtTime24, fmt$2dp, dayDiff } from '../components/adminos/format';

const text = (v) => String(v === null || v === undefined ? '' : v).trim();
const ymdOf = (v) => (v ? String(v).slice(0, 10) : null);

function readJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; }
}

// Signed dollars to the cent, with a true minus sign as the design draws it.
// A value that is not a number renders as zero: the shared formatters answer a
// dash glyph for bad input, and phone copy carries none.
const MINUS = String.fromCharCode(0x2212);
function dollars(n) {
  const num = Number(n);
  if (n === null || n === undefined || n === '' || !Number.isFinite(num)) return fmt$2dp(0);
  return num < 0 ? `${MINUS}${fmt$2dp(Math.abs(num))}` : fmt$2dp(num);
}
const fromCents = (n) => (n === null || n === undefined ? dollars(0) : dollars(Number(n) / 100));

// "AUG 8": uppercase like the rail and the when line. Empty for a bad date.
function monthDay(date) {
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
}
const dayOfYmd = (ymd) => (/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || '')) ? monthDay(new Date(`${ymd}T12:00:00`)) : '');
const dayOfInstant = (iso) => (iso ? monthDay(new Date(iso)) : '');

export function headerOf(proposal) {
  const p = proposal || {};
  const venue = text(p.event_location);
  // Same rule as AddressLink: geocode the street address, not the venue name.
  const query = venue ? (venueMapQuery(p) || venue) : '';
  return {
    title: text(p.client_name) || 'Event',
    kind: getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom }),
    guests: p.guest_count === null || p.guest_count === undefined ? null : Number(p.guest_count),
    venue,
    mapHref: query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : null,
  };
}

export function whenOf(proposal, { todayYmd } = {}) {
  const p = proposal || {};
  const ymd = ymdOf(p.event_date);
  const rail = ymd ? railParts(ymd) : null;
  const thisYear = todayYmd ? todayYmd.slice(0, 4) : String(new Date().getFullYear());
  const date = rail && rail.day
    ? `${rail.dow} ${rail.mon} ${rail.day}${ymd.slice(0, 4) !== thisYear ? ` ${ymd.slice(0, 4)}` : ''}`
    : '';
  const range = p.event_start_time ? fmtTimeRange24(p.event_start_time, null, p.event_duration_hours) : '';
  return {
    text: [date, range].filter(Boolean).join(' · '),
    isToday: !!ymd && dayDiff(ymd, todayYmd) === 0,
  };
}

const minutesOf = (clock) => {
  const m = /^(\d{2}):(\d{2})$/.exec(fmtTime24(clock));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// The clock time is the server's (setup_time_display). The gap is read back
// from the two clock times instead of re-deriving the default minutes here:
// the hosted-versus-not rule lives on the server and must not grow a twin.
export function setupOf(proposal) {
  const p = proposal || {};
  const at = text(p.setup_time_display);
  if (!at) return null;
  const start = minutesOf(p.event_start_time);
  const setup = minutesOf(at);
  if (start === null || setup === null) return `from ${at}`;
  const gap = (((start - setup) % 1440) + 1440) % 1440;
  return gap ? `from ${at} · ${gap} min before` : `from ${at}`;
}

function phoneLinks(raw) {
  const dialable = text(raw).replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  const hasDigits = /\d/.test(dialable);
  return { telHref: hasDigits ? `tel:${dialable}` : null, smsHref: hasDigits ? `sms:${dialable}` : null };
}

// `dayOf` is the body of GET /drink-plans/by-proposal/:id?fields=day_of_contact,
// `{ day_of_contact: { name, phone } | null }`. The phone never reads the full
// drink plan: that payload carries the plan's token, the internal notes and
// the venue access notes, and none of it may sit in the phone's cache.
export function contactsOf(proposal, dayOf) {
  const p = proposal || {};
  const raw = dayOf && typeof dayOf === 'object' ? dayOf.day_of_contact : null;
  const name = text(raw && raw.name);
  const dayOfPhone = text(raw && raw.phone);
  const email = text(p.client_email);
  return {
    summary: name ? 'day-of set' : 'day-of pending',
    client: {
      phone: text(p.client_phone) ? formatPhone(p.client_phone) : '',
      ...phoneLinks(p.client_phone),
      email,
      mailHref: email ? `mailto:${email}` : null,
    },
    dayOf: name ? { name, phone: dayOfPhone ? formatPhone(dayOfPhone) : '', ...phoneLinks(dayOfPhone) } : null,
  };
}

// One group per shift. A head shows only when the event has more than one
// shift; it tells shifts apart by start time and roles, and by date when the
// event spans more than one day.
export function staffingOf(shifts, proposal) {
  const list = Array.isArray(shifts) ? shifts : [];
  const status = proposal ? proposal.status : undefined;
  const views = list.map((s) => buildShiftView({ ...s, proposal_status: status ?? s.proposal_status }, s.requesters));
  const days = new Set(list.map((s) => ymdOf(s.event_date)));
  const groups = list.map((s, i) => {
    const ymd = ymdOf(s.event_date);
    const rail = ymd ? railParts(ymd) : null;
    const parts = [
      days.size > 1 && rail && rail.day ? `${rail.dow} ${rail.mon} ${rail.day}` : null,
      fmtTime24(s.start_time) || null,
      views[i].rolesLabel,
    ].filter(Boolean);
    return { shiftId: s.id, showHead: list.length > 1, label: parts.join(' · '), view: views[i] };
  });
  const slots = views.reduce((sum, v) => sum + v.slots, 0);
  const filled = views.reduce((sum, v) => sum + v.filled, 0);
  const closed = views.length > 0 && views.every((v) => !!v.closedReason);
  const cancelled = views.length > 0 && views.every((v) => v.closedReason === 'cancelled');
  let state = 'open';
  if (closed) state = 'closed';
  else if (views.length > 0 && filled >= slots) state = 'full';
  return { groups, count: views.length === 0 || cancelled ? '' : `${filled}/${slots}`, state };
}

const PAID_STATUSES = ['balance_paid', 'confirmed', 'completed'];

export function financialsOf(proposal, invoicesPayload) {
  const p = proposal || {};
  const total = Number(p.total_price || 0);
  const paid = Number(p.amount_paid || 0);
  const owed = total - paid;

  const snapshot = readJson(p.pricing_snapshot);
  const breakdown = snapshot && Array.isArray(snapshot.breakdown) ? snapshot.breakdown : [];
  const lines = breakdown.length
    ? breakdown.map((b) => ({ label: resolveGratuityDisplayLabel(b.label, snapshot), amount: dollars(b.amount) }))
    : [{ label: text(p.package_name) || 'Package', amount: dollars(total) }];

  const payload = invoicesPayload && typeof invoicesPayload === 'object' ? invoicesPayload : null;
  const invoices = payload && Array.isArray(payload.invoices) ? payload.invoices : null;
  // null, not []: "the payment detail could not be read" must never render as
  // "no payments were made".
  const payments = invoices
    ? invoices
      .filter((i) => i.status !== 'void' && Number(i.amount_paid) > 0)
      .map((i) => {
        const got = Number(i.amount_paid);
        const due = Number(i.amount_due);
        return {
          key: `i${i.id}`,
          label: text(i.label) || text(i.invoice_number) || 'Payment',
          sub: got >= due ? 'paid' : `part paid · ${fromCents(got)} of ${fromCents(due)}`,
          amount: fromCents(got),
        };
      })
    : null;

  // The bank debit in flight (spec 2026-09-14): money that has left the
  // client's hands and has not settled. Four to six days for an ACH.
  const pending = payload && Array.isArray(payload.pending_payments)
    ? payload.pending_payments.map((pp, i) => {
      const started = dayOfInstant(pp.started_at);
      return {
        key: `p${i}`,
        label: 'Bank payment processing',
        sub: [started ? `started ${started}` : null, text(pp.invoice_number) || null].filter(Boolean).join(' · '),
        amount: fromCents(pp.amount_cents),
      };
    })
    : [];

  const archived = p.status === 'archived';
  const paidInFull = PAID_STATUSES.includes(p.status) && owed <= 0;
  const inFlight = pending.length > 0;
  const due = dayOfYmd(ymdOf(p.balance_due_date));
  const dueText = due ? `due ${due}` : 'due date not set';

  let chip;
  if (archived) chip = { kind: 'neutral', label: 'Cancelled' };
  else if (inFlight) chip = { kind: 'info', label: 'Processing' };
  else if (paidInFull) chip = { kind: 'ok', label: 'Paid' };
  else if (owed > 0) chip = { kind: 'warn', label: 'Balance due' };
  else chip = { kind: 'neutral', label: 'No balance' };

  return {
    lines,
    total: dollars(total),
    payments,
    pending,
    paidToDate: dollars(paid),
    paidInFull,
    balance: owed > 0
      ? { amount: dollars(owed), sub: inFlight ? `${dueText} · bank payment in flight` : dueText, inFlight }
      : null,
    chip,
  };
}

// The detail makes four reads; any of them may have been served from cache.
// The staleness line reports the oldest, because that is how old the least
// fresh thing on screen is.
export function earliestStale(...stamps) {
  const times = stamps
    .filter(Boolean)
    .map((s) => ({ s, t: new Date(s).getTime() }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  return times.length ? times[0].s : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/eventDetailView.test.js`
Expected: PASS, 39 tests.

- [ ] **Step 5: Build and commit**

```bash
cd client && CI=true npx react-scripts build && cd .. && git add client/src/utils/eventDetailView.js client/src/utils/eventDetailView.test.js && git commit -F - <<'MSG'
feat(phone detail): pure view-model for the event detail

Header with an address-only map query, the when and setup lines, contacts as
tap targets with the day-of contact read from its projection (never the full
drink plan), staffing groups per shift,
and financials that follow the desktop payment panel figure for figure, with
the bank debit in flight as its own row and chip. Nothing here computes a
price.
MSG
```

---
### Task 8a: The rich detail header and the layout hand-off

**Files:**
- Modify: `client/src/components/mobile/MobileHeader.js`
- Modify: `client/src/components/AdminLayout.js` (`outletCtx` `:139`; the phone branch's `<MobileHeader>` `:245-249`)
- Test: `client/src/components/mobile/MobileHeader.test.js` (new)

**Interfaces:**
- Consumes: Task 5's header classes; `useMobileView()` -> `{ setDesktopView(screenKey, on) }`; `usePalette()` -> `{ openPalette }`.
- Produces, for Task 8b:
  - `MobileHeader({ title, screenKey, onBack, backLabel = 'Back', detail })` where `detail` is `null` or the header object `{ title, kind, guests, venue, mapHref }` (Task 7's `headerOf`). With `detail` the header renders the rich variant and the title is an `h1`.
  - The outlet context gains `setHeaderDetail(detail | null)`. It is `{ badges, refreshBadges, setHeaderDetail }`. The layout clears the detail on every pathname change.

This task changes the chrome every phone screen renders inside. It has no automated test for the layout threading itself (mounting `AdminLayout` needs the whole app); that is checked by Task 8b's page suite from the other side, by D1 in the browser gate, and by the chrome suites in Step 5, which must not change.

- [ ] **Step 1: Write the failing header test**

Create `client/src/components/mobile/MobileHeader.test.js`:

```js
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import MobileHeader from './MobileHeader';

const mockPalette = { openPalette: jest.fn() };
jest.mock('../../context/PaletteContext', () => ({ usePalette: () => mockPalette }));
const mockMobileView = { setDesktopView: jest.fn() };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockMobileView }));

const DETAIL = {
  title: 'Alexis Henderson', kind: 'Wedding Reception', guests: 140,
  venue: 'Grove on the River, 12 River Rd, Rockford', mapHref: 'https://www.google.com/maps/search/?api=1&query=12%20River%20Rd',
};

test('a list screen keeps the plain title, the brand mark and search', () => {
  render(<MobileHeader title="Events" screenKey="events-list" />);
  expect(screen.getByText('Events')).toHaveClass('m-title');
  expect(screen.queryByRole('heading')).toBeNull();
  expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
  expect(screen.getByRole('banner')).not.toHaveClass('m-header-detail');
});

test('a detail screen with no data yet shows the plain title and the back arrow', () => {
  const onBack = jest.fn();
  render(<MobileHeader title="Event" screenKey="event-detail" onBack={onBack} detail={null} />);
  expect(screen.getByText('Event')).toHaveClass('m-title');
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
});

test('the rich header carries client, kind, guests and the venue as an external map link', () => {
  render(<MobileHeader title="Event" screenKey="event-detail" onBack={() => {}} detail={DETAIL} />);
  expect(screen.getByRole('banner')).toHaveClass('m-header', 'm-header-detail');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Alexis Henderson · Wedding Reception');
  expect(screen.getByText('140')).toHaveClass('m-dhead-guests');
  const link = screen.getByRole('link', { name: /Grove on the River/ });
  expect(link).toHaveAttribute('href', DETAIL.mapHref);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.queryByText('Event')).toBeNull();
});

test('no venue, no link; a venue with no map query is plain text; no guests, no count', () => {
  const { rerender } = render(<MobileHeader title="Event" screenKey="event-detail" onBack={() => {}} detail={{ ...DETAIL, venue: '', mapHref: null, guests: null }} />);
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.queryByText('GUESTS')).toBeNull();
  rerender(<MobileHeader title="Event" screenKey="event-detail" onBack={() => {}} detail={{ ...DETAIL, mapHref: null }} />);
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByText(/Grove on the River/)).toBeInTheDocument();
});

test('the back arrow can name where it goes', () => {
  render(<MobileHeader title="Event" screenKey="event-detail" onBack={() => {}} backLabel="Back to Events" detail={DETAIL} />);
  expect(screen.getByRole('button', { name: 'Back to Events' })).toBeInTheDocument();
});

test('the Desktop-view escape still switches this screen', () => {
  render(<MobileHeader title="Event" screenKey="event-detail" onBack={() => {}} detail={DETAIL} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch to desktop view' }));
  expect(mockMobileView.setDesktopView).toHaveBeenCalledWith('event-detail', true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/mobile/MobileHeader.test.js`
Expected: three tests PASS (the list screen, the detail screen with no data yet, the Desktop-view escape) and three FAIL: the rich header (no heading, no link, no `m-header-detail`), the no-venue variant, and the back label (today's label is always "Back").

- [ ] **Step 3: Add the rich variant to the header**

Replace the whole of `client/src/components/mobile/MobileHeader.js` with:

```js
import React from 'react';
import Icon from '../adminos/Icon';
import { usePalette } from '../../context/PaletteContext';
import { useMobileView } from '../../context/MobileViewContext';

// Top bar of the phone chrome (benchmark composition): the brand chip on list
// screens, a back arrow instead on detail screens, title, global search
// (opens the existing command palette until the full-screen search screen
// lands), and the per-screen Desktop-view escape hatch (spec section 3).
// Benchmark details honored: the detail variant drops the search button, and
// the More screen drops the Desktop-view escape (More has no desktop
// counterpart; the toggle would just wrap this same list in the sidebar).
//
// `detail` is the rich header of a phone detail screen (client, kind, guests,
// venue as a map link). The screen hands it to the chrome through the outlet
// context once its read lands; until then, and on every screen that never
// sets one, the plain title shows.
//
// The plain title is deliberately NOT an h1: desktop pages rendering inside
// the chrome bring their own. The rich title IS an h1: the phone detail screen
// renders no other heading, and a page with none is a page a screen reader
// cannot name.
export default function MobileHeader({ title, screenKey, onBack = null, backLabel = 'Back', detail = null }) {
  const { openPalette } = usePalette();
  const { setDesktopView } = useMobileView();
  return (
    <header className={`m-header${detail ? ' m-header-detail' : ''}`}>
      {onBack ? (
        <button type="button" className="m-iconbtn" onClick={onBack} aria-label={backLabel}>
          <Icon name="left" size={20} />
        </button>
      ) : (
        <span className="m-brandmark" aria-hidden="true">&#8478;</span>
      )}
      {detail ? (
        <span className="m-dhead">
          <span className="m-dhead-line">
            <h1 className="m-dhead-title">
              {detail.title}
              {detail.kind ? <span className="m-dhead-kind">{` · ${detail.kind}`}</span> : null}
            </h1>
            {detail.guests !== null && detail.guests !== undefined && (
              <span className="m-dhead-guests">{detail.guests} <small>GUESTS</small></span>
            )}
          </span>
          {detail.venue && detail.mapHref && (
            <a className="m-dhead-venue" href={detail.mapHref} target="_blank" rel="noopener noreferrer">
              <span>{detail.venue}</span>
              <Icon name="external" size={12} />
            </a>
          )}
          {detail.venue && !detail.mapHref && (
            <span className="m-dhead-venue"><span>{detail.venue}</span></span>
          )}
        </span>
      ) : (
        <span className="m-title">{title}</span>
      )}
      {!onBack && (
        <button
          type="button"
          className="m-iconbtn"
          onClick={openPalette}
          aria-label="Search"
        >
          <Icon name="search" size={20} />
        </button>
      )}
      {screenKey !== 'more' && (
        <button
          type="button"
          className="m-iconbtn"
          onClick={() => setDesktopView(screenKey, true)}
          aria-label="Switch to desktop view"
          title="Desktop view"
        >
          <Icon name="external" size={20} />
        </button>
      )}
    </header>
  );
}
```

- [ ] **Step 4: Thread the header detail through the layout**

In `client/src/components/AdminLayout.js`, replace the `outletCtx` definition (`:139`) with:

```js
  // A phone detail screen hands the chrome what its rich header shows (client,
  // kind, guests, venue link). Cleared on every route change, so one event's
  // header can never sit over another screen.
  const [headerDetail, setHeaderDetail] = useState(null);
  useEffect(() => { setHeaderDetail(null); }, [location.pathname]);

  // One context object for BOTH shells: the phone branch already fed badges
  // through it, the desktop branch fed nothing, and the hub needs refreshBadges
  // on either one.
  const outletCtx = useMemo(
    () => ({ badges, refreshBadges: fetchBadges, setHeaderDetail }),
    [badges, fetchBadges]
  );
```

(The comment that begins "One context object for BOTH shells" already sits above the old definition; keep one copy.) In the phone branch, add two props to `<MobileHeader>`:

```js
          <MobileHeader
            title={screenTitle(screenKey)}
            screenKey={screenKey}
            onBack={isDetail ? onBack : null}
            backLabel={screenKey === 'proposal-detail' ? 'Back to Proposals' : 'Back to Events'}
            detail={isDetail ? headerDetail : null}
          />
```

- [ ] **Step 5: Run the header test and the chrome suites**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/mobile src/context`
Expected: `MobileHeader.test.js` PASS, 6 tests; every other suite in those folders unchanged.

- [ ] **Step 6: Build and commit**

```bash
wc -l client/src/components/AdminLayout.js && cd client && CI=true npx react-scripts build && cd .. && git add client/src/components/mobile/MobileHeader.js client/src/components/mobile/MobileHeader.test.js client/src/components/AdminLayout.js && git commit -F - <<'MSG'
feat(phone chrome): rich detail header, handed over through the outlet

MobileHeader gains a detail variant: client and kind as the page heading,
guests, and the venue as an external map link. A phone detail screen hands
the chrome its header through the outlet context, and the layout clears it
on every route change so one event's header never sits over another screen.
The back arrow names where it goes.
MSG
```

Expected: the layout at about 315 lines; the build exits 0 with no warning.

---

### Task 8b: `EventDetailPhone`, the phone event detail

**Files:**
- Create: `client/src/pages/mobile/EventDetailSections.js`
- Create: `client/src/pages/mobile/EventDetailPhone.js`
- Test: `client/src/pages/mobile/EventDetailPhone.test.js`, `client/src/utils/mobileClassContract.test.js` (new)

**Interfaces:**
- Consumes: Task 3's `useDrawerParam({ push: true, kinds }) -> { kind, id, focus, open, close }`; Task 3b's `offlineGet(url, config?)` and the day-of-contact projection; Task 6's `AssignmentSheet({ shiftId, focusUserId, onClose, onChanged, onDead })`; Task 7's `headerOf, whenOf, setupOf, contactsOf, staffingOf, financialsOf, earliestStale`; Task 8a's outlet context `{ badges, refreshBadges, setHeaderDetail }`; Task 5's classes; `formatStaleTime` from `client/src/utils/staleTime.js`; `useMobileView()` -> `{ setDesktopView(screenKey, on) }`.
- Produces:
  - `client/src/pages/mobile/EventDetailSections.js`: named exports `Caret({ open })`, `ContactsSection({ open, onToggle, contacts, planState, clientName })`, `MoneySection({ open, onToggle, fin, moneyState })`. Presentational: no state, no read.
  - The default export `EventDetailPhone()` (no props; reads `:id` from the route). Task 9 mounts it.
  - Window event `mobile-route-dead`, dispatched when `GET /proposals/:id` answers 404 or 403, or when `:id` is not a number (then nothing is fetched). No other read dispatches it.
  - `client/src/utils/mobileClassContract.test.js`, which Task 9 extends.

**The four reads, all through `offlineGet`:** `/proposals/<id>`, `/shifts/by-proposal/<id>`, `/invoices/proposal/<id>`, and `/drink-plans/by-proposal/<id>` with `params: { fields: 'day_of_contact' }`. The page never requests the full drink plan.

- [ ] **Step 1: Write the failing page test**

Create `client/src/pages/mobile/EventDetailPhone.test.js`:

```js
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet, useLocation, useNavigate } from 'react-router-dom';
import EventDetailPhone from './EventDetailPhone';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
const mockMobileView = { isPhone: true, desktopView: jest.fn(() => false), setDesktopView: jest.fn() };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockMobileView }));
// The sheet has its own suite; here it is a stub that exposes its props.
jest.mock('../../components/mobile/AssignmentSheet', () => ({
  __esModule: true,
  default: ({ shiftId, focusUserId, onClose, onChanged, onDead }) => (
    <div data-testid="sheet">
      <span data-testid="sheet-shift">{String(shiftId)}</span>
      <span data-testid="sheet-focus">{String(focusUserId)}</span>
      <button type="button" onClick={onClose}>stub close</button>
      <button type="button" onClick={onChanged}>stub changed</button>
      <button type="button" onClick={onDead}>stub dead</button>
    </div>
  ),
}));

const PROPOSAL = {
  id: 13, status: 'deposit_paid', client_name: 'Alexis Henderson', client_phone: '3125550184',
  client_email: 'alexis.hend@gmail.com', event_type: 'wedding-reception', event_type_custom: null,
  event_date: '2999-08-15T00:00:00.000Z', event_start_time: '18:00', event_duration_hours: '5',
  event_location: 'Grove on the River, 12 River Rd, Rockford, Illinois 61101',
  venue_street: '12 River Rd', venue_city: 'Rockford', venue_state: 'Illinois', venue_zip: '61101',
  guest_count: 140, setup_time_display: '17:15', total_price: '3650.00', amount_paid: '1900.00',
  balance_due_date: '2999-08-08', package_name: 'Signature bar',
  pricing_snapshot: { total: 3650, breakdown: [{ label: 'Signature bar', amount: 3200 }, { label: 'Mobile bar rental', amount: 450 }] },
};
const person = (id, over = {}) => ({
  request_id: id, user_id: 100 + id, name: `Person ${id}`, status: 'approved', position: 'Bartender',
  dropped_at: null, requested_positions: '["Bartender"]', home_distance_miles: 2.4, events_worked: 87, ...over,
});
const shift = (id, over = {}) => ({
  id, status: 'open', finished: false, event_date: '2999-08-15', start_time: '18:00',
  positions_needed: '["Bartender","Bartender"]', requesters: [person(1), person(2, { status: 'pending', position: null })], ...over,
});
// The day-of-contact projection, never the full drink plan.
const PLAN = { day_of_contact: { name: 'Marcus Keller', phone: '3125550142' } };
const OFFLINE_OK = { headers: { 'X-Offline-Ok': '1' } };
const INVOICES = { invoices: [{ id: 1, invoice_number: 'INV-01', label: 'Deposit', amount_due: 10000, amount_paid: 10000, status: 'paid' }], pending_payments: [] };
const NETWORK = { status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' };

// Each value is a payload, or { reject }, or { data, staleAt }. A function is called per request.
function serve(over = {}) {
  const table = {
    '/proposals/13': { data: PROPOSAL },
    '/shifts/by-proposal/13': { data: [shift(1)] },
    '/drink-plans/by-proposal/13': { data: PLAN },
    '/invoices/proposal/13': { data: INVOICES },
    ...over,
  };
  api.get.mockImplementation((url) => {
    const entry = typeof table[url] === 'function' ? table[url]() : table[url];
    if (!entry) return Promise.reject({ status: 404, message: 'Not found' });
    return entry.reject ? Promise.reject(entry.reject) : Promise.resolve(entry);
  });
}

function Shell({ ctx }) { return <Outlet context={ctx} />; }
function Probe() {
  const l = useLocation(); const n = useNavigate();
  return (
    <>
      <div data-testid="loc">{l.pathname + l.search}</div>
      <button type="button" onClick={() => n(-1)}>back</button>
      <button type="button" onClick={() => n('/events/14')}>go to 14</button>
    </>
  );
}
function mount({ initial = '/events/13', entries } = {}) {
  const ctx = { badges: {}, refreshBadges: jest.fn(), setHeaderDetail: jest.fn() };
  const list = entries || ['/events', initial];
  const utils = render(
    <MemoryRouter initialEntries={list} initialIndex={list.length - 1}>
      <Routes>
        <Route element={<Shell ctx={ctx} />}>
          <Route path="/events/:id" element={<><EventDetailPhone /><Probe /></>} />
        </Route>
        <Route path="/events" element={<div data-testid="loc">/events</div>} />
      </Routes>
    </MemoryRouter>
  );
  return { ctx, ...utils };
}
const tap = (el) => fireEvent.click(el);
const section = (name) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

test('makes its four reads and hands the chrome the rich header', async () => {
  serve();
  const { ctx } = mount();
  await screen.findByText('Person 1');
  // Every read asks for the offline fallback: this screen renders the staleness line.
  for (const url of ['/proposals/13', '/shifts/by-proposal/13', '/invoices/proposal/13']) {
    expect(api.get).toHaveBeenCalledWith(url, OFFLINE_OK);
  }
  // The drink plan is read as its projection, and only as that.
  expect(api.get).toHaveBeenCalledWith('/drink-plans/by-proposal/13', { params: { fields: 'day_of_contact' }, ...OFFLINE_OK });
  expect(api.get.mock.calls.filter((c) => c[0] === '/drink-plans/by-proposal/13' && !(c[1] && c[1].params))).toHaveLength(0);
  // The header is handed over in an effect, one tick after the rows paint.
  await waitFor(() => expect(ctx.setHeaderDetail).toHaveBeenLastCalledWith(expect.objectContaining({
    title: 'Alexis Henderson', kind: 'Wedding Reception', guests: 140,
    mapHref: expect.stringContaining('query=12%20River%20Rd'),
  })));
});

test('the header is cleared when the screen goes away', async () => {
  serve();
  const { ctx, unmount } = mount();
  await screen.findByText('Person 1');
  unmount();
  expect(ctx.setHeaderDetail).toHaveBeenLastCalledWith(null);
});

test('the when and setup lines, and Staffing open by default with the other two closed', async () => {
  serve();
  mount();
  await screen.findByText('Person 1');
  expect(screen.getByText(/· 18:00–23:00 · 5h$/)).toHaveClass('m-detail-whenline');
  expect(screen.getByText('setup from 17:15 · 45 min before')).toHaveClass('m-detail-setup');
  expect(section('Staffing')).toHaveAttribute('aria-expanded', 'true');
  expect(section('Contacts')).toHaveAttribute('aria-expanded', 'false');
  expect(section('Financials')).toHaveAttribute('aria-expanded', 'false');
  expect(within(section('Staffing')).getByText('1/2')).toBeInTheDocument();
  expect(within(section('Contacts')).getByText('day-of set')).toBeInTheDocument();
  expect(within(section('Financials')).getByText('$3,650.00')).toBeInTheDocument();
  expect(within(section('Financials')).getByText('Balance due')).toBeInTheDocument();
  expect(screen.queryByText('Client')).toBeNull();
});

test('a live read shows "as of"; a cache-served read shows the offline copy line with the dot', async () => {
  serve();
  const first = mount();
  await screen.findByText('Person 1');
  expect(screen.getByText(/^as of/)).toBeInTheDocument();
  expect(document.querySelector('.m-stale-dot')).toBeNull();
  first.unmount();

  serve({ '/shifts/by-proposal/13': { data: [shift(1)], staleAt: '2026-09-29T17:00:00.000Z' } });
  mount();
  await screen.findByText('Person 1');
  expect(screen.getByText(/^offline copy · as of/)).toBeInTheDocument();
  expect(document.querySelector('.m-stale-dot')).not.toBeNull();
});

test('Contacts: every number and address is a tap target', async () => {
  serve();
  mount();
  await screen.findByText('Person 1');
  tap(section('Contacts'));
  expect(screen.getByRole('link', { name: '(312) 555-0184' })).toHaveAttribute('href', 'tel:3125550184');
  expect(screen.getByRole('link', { name: 'Text Alexis Henderson' })).toHaveAttribute('href', 'sms:3125550184');
  expect(screen.getByRole('link', { name: 'alexis.hend@gmail.com' })).toHaveAttribute('href', 'mailto:alexis.hend@gmail.com');
  expect(screen.getByText('Marcus Keller')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '(312) 555-0142' })).toHaveAttribute('href', 'tel:3125550142');
  expect(screen.getByRole('link', { name: 'Text Marcus Keller' })).toHaveAttribute('href', 'sms:3125550142');
});

test('a drink-plan 404 is "no day-of contact yet", not an error', async () => {
  serve({ '/drink-plans/by-proposal/13': { reject: { status: 404, message: 'No drink plan found for this proposal.' } } });
  mount();
  await screen.findByText('Person 1');
  expect(within(section('Contacts')).getByText('day-of pending')).toBeInTheDocument();
  tap(section('Contacts'));
  expect(screen.getByText('Not received yet. Collected with the drink plan; often the client themselves.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a drink-plan read that failed says it needs a connection, and does not claim the contact is missing', async () => {
  serve({ '/drink-plans/by-proposal/13': { reject: NETWORK } });
  mount();
  await screen.findByText('Person 1');
  tap(section('Contacts'));
  expect(screen.getByText('The day-of contact needs a connection.')).toBeInTheDocument();
  expect(screen.queryByText(/Not received yet/)).toBeNull();
});

test('Financials: lines, total, payments and the balance', async () => {
  serve();
  mount();
  await screen.findByText('Person 1');
  tap(section('Financials'));
  expect(screen.getByText('Package & extras')).toBeInTheDocument();
  expect(screen.getByText('Signature bar')).toBeInTheDocument();
  expect(screen.getByText('$3,200.00')).toBeInTheDocument();
  expect(screen.getByText('Total')).toBeInTheDocument();
  expect(screen.queryByText('Updated total')).toBeNull();
  expect(screen.getByText('Payments')).toBeInTheDocument();
  expect(screen.getByText('Deposit')).toBeInTheDocument();
  expect(screen.getByText('$100.00')).toBeInTheDocument();
  expect(screen.getByText('$1,750.00')).toBeInTheDocument();
  expect(screen.getByText('due AUG 8')).toBeInTheDocument();
});

test('a bank payment in flight shows on the chip, as a row, and on the balance', async () => {
  serve({ '/invoices/proposal/13': { data: { ...INVOICES, pending_payments: [{ amount_cents: 175000, started_at: '2999-08-05T15:00:00.000Z', invoice_id: 2, invoice_number: 'INV-0363' }] } } });
  mount();
  await screen.findByText('Person 1');
  await waitFor(() => expect(within(section('Financials')).getByText('Processing')).toBeInTheDocument());
  tap(section('Financials'));
  expect(screen.getByText('Bank payment processing')).toBeInTheDocument();
  expect(screen.getByText(/^started .* · INV-0363$/)).toBeInTheDocument();
  expect(screen.getByText('due AUG 8 · bank payment in flight')).toBeInTheDocument();
  expect(screen.getByText('due AUG 8 · bank payment in flight').closest('.m-money-row')).toHaveClass('m-money-bal', 'm-money-flight');
});

test('paid in full', async () => {
  serve({ '/proposals/13': { data: { ...PROPOSAL, status: 'balance_paid', amount_paid: '3650.00' } } });
  mount();
  await screen.findByText('Person 1');
  expect(within(section('Financials')).getByText('Paid')).toBeInTheDocument();
  tap(section('Financials'));
  expect(screen.getByText('Paid in full')).toBeInTheDocument();
  expect(screen.queryByText('Balance due')).toBeNull();
});

test('a failed invoices read says the payment detail needs a connection and still shows what was paid', async () => {
  serve({ '/invoices/proposal/13': { reject: NETWORK } });
  mount();
  await screen.findByText('Person 1');
  tap(section('Financials'));
  expect(screen.getByText('Payment detail needs a connection.')).toBeInTheDocument();
  expect(screen.getByText('Paid to date')).toBeInTheDocument();
  expect(screen.getByText('$1,900.00')).toBeInTheDocument();
});

test('a staffing row opens the sheet on that person and pushes one history entry', async () => {
  serve();
  mount();
  tap(await screen.findByRole('button', { name: /Person 2/ }));
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/events/13?drawer=shift&drawerId=1&drawerFocus=102'));
  expect(screen.getByTestId('sheet-shift')).toHaveTextContent('1');
  expect(screen.getByTestId('sheet-focus')).toHaveTextContent('102');
  tap(screen.getByRole('button', { name: 'back' }));
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/));
  expect(screen.queryByTestId('sheet')).toBeNull();
});

test('"Assign staff · 1 open" opens the sheet with nobody focused', async () => {
  serve();
  mount();
  tap(await screen.findByRole('button', { name: 'Assign staff · 1 open' }));
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/events/13?drawer=shift&drawerId=1'));
  expect(screen.getByTestId('sheet-focus')).toHaveTextContent('null');
});

test('applicant and waitlisted rows carry their chips and their meta', async () => {
  serve({ '/shifts/by-proposal/13': { data: [shift(1, { positions_needed: '["Bartender"]', requesters: [
    person(1), person(2, { status: 'pending', position: null, events_worked: 14, home_distance_miles: null }),
  ] })] } });
  mount();
  const waiting = await screen.findByRole('button', { name: /Person 2/ });
  expect(within(waiting).getByText('Waitlisted')).toBeInTheDocument();
  expect(within(waiting).getByText('Bartender · 14 events')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Assign staff/ })).toBeNull();
});

test('two shifts get a head each; one shift gets none', async () => {
  serve({ '/shifts/by-proposal/13': { data: [
    shift(1, { start_time: '16:00' }),
    shift(2, { start_time: '17:00', positions_needed: '["Banquet Server"]', requesters: [] }),
  ] } });
  mount();
  expect(await screen.findByText('16:00 · Bartenders')).toHaveClass('m-shift-label');
  expect(screen.getByText('17:00 · Banquet Servers')).toBeInTheDocument();
  // One "Assign staff" row per shift, each opening its own sheet.
  const rows = screen.getAllByRole('button', { name: 'Assign staff · 1 open' });
  expect(rows).toHaveLength(2);
  tap(rows[1]);
  await waitFor(() => expect(screen.getByTestId('sheet-shift')).toHaveTextContent('2'));
});

test('after the sheet changes something the staffing card and the tab badge refresh', async () => {
  let reads = 0;
  serve({ '/shifts/by-proposal/13': () => { reads += 1; return { data: [shift(1, reads > 1 ? { requesters: [person(1), person(2)] } : {})] }; } });
  const { ctx } = mount({ initial: '/events/13?drawer=shift&drawerId=1' });
  await screen.findByText('Person 1');
  expect(within(section('Staffing')).getByText('1/2')).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'stub changed' }));
  await waitFor(() => expect(within(section('Staffing')).getByText('2/2')).toBeInTheDocument());
  expect(ctx.refreshBadges).toHaveBeenCalledTimes(1);
});

test('a dead sheet closes itself and stays on the event', async () => {
  serve();
  mount({ initial: '/events/13?drawer=shift&drawerId=999' });
  await screen.findByText('Person 1');
  tap(screen.getByRole('button', { name: 'stub dead' }));
  await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/events\/13$/));
  expect(screen.queryByTestId('sheet')).toBeNull();
});

test('an id that is not a number is a dead route: nothing is fetched and no error screen shows', async () => {
  const heard = jest.fn();
  window.addEventListener('mobile-route-dead', heard);
  serve();
  render(
    <MemoryRouter initialEntries={['/events/abc']}>
      <Routes>
        <Route element={<Shell ctx={{ badges: {}, refreshBadges: jest.fn(), setHeaderDetail: jest.fn() }} />}>
          <Route path="/events/:id" element={<EventDetailPhone />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
  await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
  expect(api.get).not.toHaveBeenCalled();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('Loading the event')).toBeNull();
  window.removeEventListener('mobile-route-dead', heard);
});

test('a drawerId that is not a number mounts no sheet', async () => {
  serve();
  mount({ initial: '/events/13?drawer=shift&drawerId=abc' });
  await screen.findByText('Person 1');
  expect(screen.queryByTestId('sheet')).toBeNull();
});

test('a proposal that is gone or denied dispatches mobile-route-dead and renders no error screen', async () => {
  for (const status of [404, 403]) {
    const heard = jest.fn();
    window.addEventListener('mobile-route-dead', heard);
    serve({ '/proposals/13': { reject: { status, message: 'nope' } } });
    const { unmount } = mount();
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
    window.removeEventListener('mobile-route-dead', heard);
    unmount();
  }
});

test('a manager without staffing access gets the event without its roster, not thrown back to the list', async () => {
  const heard = jest.fn();
  window.addEventListener('mobile-route-dead', heard);
  serve({ '/shifts/by-proposal/13': { reject: { status: 403, message: 'Staffing access required.' } } });
  mount();
  expect(await screen.findByText('Staffing needs staffing access.')).toBeInTheDocument();
  expect(screen.getByText('setup from 17:15 · 45 min before')).toBeInTheDocument();
  expect(heard).not.toHaveBeenCalled();
  window.removeEventListener('mobile-route-dead', heard);
});

test('a failed staffing read offers Retry and recovers without reloading the event', async () => {
  let reads = 0;
  serve({ '/shifts/by-proposal/13': () => { reads += 1; return reads === 1 ? { reject: NETWORK } : { data: [shift(1)] }; } });
  mount();
  expect(await screen.findByText("Couldn't load staffing.")).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Person 1')).toBeInTheDocument();
  expect(api.get.mock.calls.filter((c) => c[0] === '/proposals/13')).toHaveLength(1);
});

test('an event with no shifts says so', async () => {
  serve({ '/shifts/by-proposal/13': { data: [] } });
  mount();
  expect(await screen.findByText('No shifts created for this event yet.')).toBeInTheDocument();
});

test('a lost connection with nothing cached shows the error with Retry, and recovers', async () => {
  let reads = 0;
  serve({ '/proposals/13': () => { reads += 1; return reads === 1 ? { reject: NETWORK } : { data: PROPOSAL }; } });
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load this event");
  expect(screen.getByRole('alert')).toHaveTextContent('Network error. Check your connection.');
  tap(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Person 1')).toBeInTheDocument();
});

test('Edit details opens the Desktop view of this screen', async () => {
  serve();
  mount();
  await screen.findByText('Person 1');
  const edit = screen.getByRole('button', { name: /^Edit details/ });
  expect(within(edit).getByText('desktop view')).toBeInTheDocument();
  tap(edit);
  expect(mockMobileView.setDesktopView).toHaveBeenCalledWith('event-detail', true);
});

test('on a cache-served read Edit details needs a connection and does nothing', async () => {
  serve({ '/proposals/13': { data: PROPOSAL, staleAt: '2026-09-29T17:00:00.000Z' } });
  mount();
  await screen.findByText('Person 1');
  const edit = screen.getByRole('button', { name: /^Edit details/ });
  expect(within(edit).getByText('needs connection')).toBeInTheDocument();
  expect(edit).toBeDisabled();
  tap(edit);
  expect(mockMobileView.setDesktopView).not.toHaveBeenCalled();
});

test('a cancelled event: the chip says so, the roster offers nothing, Edit is absent', async () => {
  serve({
    '/proposals/13': { data: { ...PROPOSAL, status: 'archived' } },
    '/shifts/by-proposal/13': { data: [shift(1, { status: 'cancelled' })] },
  });
  mount();
  await screen.findByText('Person 1');
  expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: /^Assign staff/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Edit details/ })).toBeNull();
  expect(screen.queryByText('Today')).toBeNull();
});

test('changing the event id reloads and never shows the previous event', async () => {
  serve({ '/proposals/14': { data: { ...PROPOSAL, id: 14, client_name: 'June Marrow' } }, '/shifts/by-proposal/14': { data: [] },
    '/drink-plans/by-proposal/14': { reject: { status: 404, message: 'none' } }, '/invoices/proposal/14': { data: { invoices: [], pending_payments: [] } } });
  const { ctx } = mount();
  await screen.findByText('Person 1');
  tap(screen.getByRole('button', { name: 'go to 14' }));
  // The previous event leaves the screen at once, before the new one lands.
  expect(screen.queryByText('Person 1')).toBeNull();
  expect(await screen.findByText('No shifts created for this event yet.')).toBeInTheDocument();
  await waitFor(() => expect(ctx.setHeaderDetail).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'June Marrow' })));
  expect(screen.getByText('setup from 17:15 · 45 min before')).toBeInTheDocument();
});

test('a reload of the staffing card that lands after the screen moved to another event is dropped', async () => {
  let release;
  let reads13 = 0;
  serve({
    '/shifts/by-proposal/13': () => {
      reads13 += 1;
      if (reads13 === 1) return { data: [shift(1)] };
      return { then: (resolve) => { release = () => resolve({ data: [shift(1, { requesters: [person(9, { name: 'Late Arrival' })] })] }); } };
    },
    '/proposals/14': { data: { ...PROPOSAL, id: 14, client_name: 'June Marrow' } },
    '/shifts/by-proposal/14': { data: [] },
    '/drink-plans/by-proposal/14': { reject: { status: 404, message: 'none' } },
    '/invoices/proposal/14': { data: { invoices: [], pending_payments: [] } },
  });
  mount({ initial: '/events/13?drawer=shift&drawerId=1' });
  await screen.findByText('Person 1');
  tap(screen.getByRole('button', { name: 'stub changed' }));   // starts the slow reload for 13
  tap(screen.getByRole('button', { name: 'go to 14' }));
  expect(await screen.findByText('No shifts created for this event yet.')).toBeInTheDocument();
  await waitFor(() => expect(typeof release).toBe('function'));
  release();
  await waitFor(() => expect(api.get.mock.calls.filter((c) => c[0] === '/shifts/by-proposal/13')).toHaveLength(2));
  expect(screen.queryByText('Late Arrival')).toBeNull();
  expect(screen.getByText('No shifts created for this event yet.')).toBeInTheDocument();
});

test('a shift with no declared roles shows the note on the card instead of an Assign row', async () => {
  serve({ '/shifts/by-proposal/13': { data: [shift(1, { positions_needed: '[]', requesters: [] })] } });
  mount();
  expect(await screen.findByText('No roles are declared on this shift. Staff it from desktop view.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Assign staff/ })).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/mobile/EventDetailPhone.test.js`
Expected: FAIL, `Cannot find module './EventDetailPhone'`.

- [ ] **Step 3: Write the presentational sections**

Create `client/src/pages/mobile/EventDetailSections.js`:

```js
import React from 'react';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';

// The presentational sections of the phone event detail (spec
// 2026-08-13-mobile-admin section 4 Detail; benchmark 2026-09-15, Event
// detail). They render what client/src/utils/eventDetailView.js derived and
// hold no state and make no read: EventDetailPhone owns both.

export function Caret({ open }) {
  return (
    <span className={`m-section-caret${open ? ' m-section-caret-open' : ''}`} aria-hidden="true">
      <Icon name="right" size={16} />
    </span>
  );
}

function PhoneLine({ label, links, who }) {
  if (!label) return null;
  return (
    <div className="m-contact-line">
      {links.telHref
        ? <a className="m-contact-link" href={links.telHref}>{label}</a>
        : <span className="m-contact-link">{label}</span>}
      {links.smsHref && <a className="m-contact-act" href={links.smsHref} aria-label={`Text ${who}`}>Text</a>}
    </div>
  );
}

export function ContactsSection({ open, onToggle, contacts, planState, clientName }) {
  return (
    <section className="m-section">
      <button type="button" className="m-section-row" aria-expanded={open} onClick={onToggle}>
        <Icon name="users" size={20} />
        <span className="m-section-name">Contacts</span>
        {(planState === 'ready' || planState === 'none') && <span className="m-section-sum">{contacts.summary}</span>}
        <Caret open={open} />
      </button>
      {open && (
        <>
          <div className="m-section-label">Client</div>
          <div className="m-contact">
            <PhoneLine label={contacts.client.phone} links={contacts.client} who={clientName || 'the client'} />
            {contacts.client.email && (
              <div className="m-contact-line">
                <a className="m-contact-link" href={contacts.client.mailHref}>{contacts.client.email}</a>
              </div>
            )}
            {!contacts.client.phone && !contacts.client.email && (
              <div className="m-section-note">No phone or email on file.</div>
            )}
          </div>
          <div className="m-section-label">Day-of contact</div>
          {contacts.dayOf && (
            <div className="m-contact">
              <div className="m-contact-name">{contacts.dayOf.name}</div>
              <PhoneLine label={contacts.dayOf.phone} links={contacts.dayOf} who={contacts.dayOf.name} />
            </div>
          )}
          {!contacts.dayOf && planState === 'failed' && (
            <div className="m-section-note">The day-of contact needs a connection.</div>
          )}
          {!contacts.dayOf && planState === 'loading' && (
            <div className="m-section-note">Loading the day-of contact</div>
          )}
          {!contacts.dayOf && (planState === 'ready' || planState === 'none') && (
            <div className="m-section-note">
              <Icon name="clock" size={16} />
              <span>Not received yet. Collected with the drink plan; often the client themselves.</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function MoneySection({ open, onToggle, fin, moneyState }) {
  return (
    <section className="m-section">
      <button type="button" className="m-section-row" aria-expanded={open} onClick={onToggle}>
        <Icon name="dollar" size={20} />
        <span className="m-section-name">Financials</span>
        <span className="m-section-num">{fin.total}</span>
        <StatusChip kind={fin.chip.kind}>{fin.chip.label}</StatusChip>
        <Caret open={open} />
      </button>
      {open && (
        <>
          <div className="m-section-label">Package &amp; extras</div>
          {fin.lines.map((line, i) => (
            <div className="m-money-row" key={`${line.label}-${i}`}>
              <span className="m-money-main"><span className="m-money-label">{line.label}</span></span>
              <span className="m-money-amt">{line.amount}</span>
            </div>
          ))}
          <div className="m-money-row m-money-total">
            <span className="m-money-main"><span className="m-money-label">Total</span></span>
            <span className="m-money-amt">{fin.total}</span>
          </div>
          <div className="m-section-label">Payments</div>
          {fin.payments === null && (
            <>
              <div className="m-section-note">
                {moneyState === 'loading' ? 'Loading the payment detail' : 'Payment detail needs a connection.'}
              </div>
              <div className="m-money-row">
                <span className="m-money-main"><span className="m-money-label">Paid to date</span></span>
                <span className="m-money-amt">{fin.paidToDate}</span>
              </div>
            </>
          )}
          {fin.payments !== null && fin.payments.length === 0 && fin.pending.length === 0 && (
            <div className="m-section-note">No payments yet.</div>
          )}
          {(fin.payments || []).map((pay) => (
            <div className="m-money-row m-money-pay" key={pay.key}>
              <span className="m-money-main">
                <span className="m-money-label">{pay.label}</span>
                <span className="m-money-sub">{pay.sub}</span>
              </span>
              <span className="m-money-amt">{pay.amount}</span>
            </div>
          ))}
          {fin.pending.map((pay) => (
            <div className="m-money-row m-money-pay" key={pay.key}>
              <span className="m-money-main">
                <span className="m-money-label">{pay.label}</span>
                {pay.sub ? <span className="m-money-sub">{pay.sub}</span> : null}
              </span>
              <span className="m-money-amt">{pay.amount}</span>
            </div>
          ))}
          {fin.balance && (
            <div className={`m-money-row m-money-bal${fin.balance.inFlight ? ' m-money-flight' : ''}`}>
              <span className="m-money-main">
                <span className="m-money-label">Balance due</span>
                <span className="m-money-sub">{fin.balance.sub}</span>
              </span>
              <span className="m-money-amt">{fin.balance.amount}</span>
            </div>
          )}
          {fin.paidInFull && (
            <div className="m-money-row m-money-paid">
              <span className="m-money-main"><span className="m-money-label">Paid in full</span></span>
              <span className="m-money-amt">{fin.total}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Write the page**

Create `client/src/pages/mobile/EventDetailPhone.js`:

```js
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { offlineGet } from '../../utils/offlineRead';
import useDrawerParam from '../../hooks/useDrawerParam';
import { useMobileView } from '../../context/MobileViewContext';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import AssignmentSheet from '../../components/mobile/AssignmentSheet';
import { formatStaleTime } from '../../utils/staleTime';
import {
  headerOf, whenOf, setupOf, contactsOf, staffingOf, financialsOf, earliestStale,
} from '../../utils/eventDetailView';
import { Caret, ContactsSection, MoneySection } from './EventDetailSections';

// Phone event detail (spec 2026-08-13-mobile-admin section 4 Detail; benchmark
// docs/design-artifacts/2026-09-15-mobile-admin-shell.dc.html, Event detail).
// Renders INSIDE AdminLayout's scrolling .m-main. The rich header is the
// chrome's: this screen hands it the data through the outlet context.
//
// Four reads, each allowed to fail on its own, each made with offlineGet (they
// may be answered from the phone's cache, and the staleness line says so).
// Only the proposal is the route: when IT is gone or denied, or the :id in the
// URL is not a number, the screen dispatches mobile-route-dead and the chrome
// falls back to /events. A missing drink plan, a roster this user may not see,
// or an invoices read that did not land each degrade one section.
//
// The drink plan is read ONLY as its day-of-contact projection. The full plan
// carries its token, the internal notes and the venue access notes, and the
// phone needs a name and a number.
//
// Not on the phone in phase 1 (reachable through the Desktop-view escape):
// the activity feed, invite to portal, re-enroll nudges, cancel event, cancel
// line, the Out-of-Area Bonus knob. The Edit details row opens that Desktop
// view until the edit sheet (lane ma-e3) lands.
const LOAD_FAILED = 'Network error. Check your connection.';
const ROSTERLESS = 'No roles are declared on this shift. Staff it from desktop view.';
// The kinds of drawer that are phone sheets here. Module scope: one identity.
const SHEETS = ['shift'];
const isDead = (err) => !!err && (err.status === 404 || err.status === 403);
const DAY_OF = { params: { fields: 'day_of_contact' } };
const FRAC = { open: 'm-frac', full: 'm-frac full', closed: 'm-frac past' };

export default function EventDetailPhone() {
  const { id } = useParams();
  const outlet = useOutletContext() || {};
  const { setHeaderDetail, refreshBadges } = outlet;
  const { setDesktopView } = useMobileView();
  const drawer = useDrawerParam({ push: true, kinds: SHEETS });
  // The id the screen is showing NOW, for reads that can land after it moved on.
  const showing = useRef(id);
  showing.current = id;

  const [proposal, setProposal] = useState(null);
  const [shifts, setShifts] = useState({ state: 'loading', rows: [] });     // loading | ready | denied | failed
  const [plan, setPlan] = useState({ state: 'loading', row: null });         // loading | ready | none | failed
  const [money, setMoney] = useState({ state: 'loading', payload: null });   // loading | ready | failed
  const [stale, setStale] = useState({});                                    // read name -> cached-at stamp
  const [fetchedAt, setFetchedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [panes, setPanes] = useState({ contact: false, staffing: true, pay: false });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // A malformed id can never load: say so at once, instead of an error
    // screen whose Retry cannot succeed.
    if (!/^\d+$/.test(String(id))) {
      setLoading(false);
      setProposal(null);
      window.dispatchEvent(new CustomEvent('mobile-route-dead'));
      return undefined;
    }
    let gone = false;
    const stamp = (name, res) => setStale((prev) => ({ ...prev, [name]: res.staleAt || null }));
    // Clear first: a different event id must never render over the last one.
    setLoading(true); setError(null); setProposal(null); setStale({}); setFetchedAt(null);
    setShifts({ state: 'loading', rows: [] });
    setPlan({ state: 'loading', row: null });
    setMoney({ state: 'loading', payload: null });

    offlineGet(`/proposals/${id}`)
      .then((res) => {
        if (gone) return;
        setProposal(res.data);
        stamp('proposal', res);
        setFetchedAt(new Date().toISOString());
      })
      .catch((err) => {
        if (gone) return;
        if (isDead(err)) { window.dispatchEvent(new CustomEvent('mobile-route-dead')); return; }
        setError((err && err.message) || LOAD_FAILED);
      })
      .finally(() => { if (!gone) setLoading(false); });

    offlineGet(`/shifts/by-proposal/${id}`)
      .then((res) => { if (gone) return; setShifts({ state: 'ready', rows: Array.isArray(res.data) ? res.data : [] }); stamp('shifts', res); })
      .catch((err) => { if (!gone) setShifts({ state: err && err.status === 403 ? 'denied' : 'failed', rows: [] }); });

    offlineGet(`/drink-plans/by-proposal/${id}`, DAY_OF)
      .then((res) => { if (gone) return; setPlan({ state: 'ready', row: res.data }); stamp('plan', res); })
      // 404 is the normal answer for an event whose client has not started a plan.
      .catch((err) => { if (!gone) setPlan({ state: err && err.status === 404 ? 'none' : 'failed', row: null }); });

    offlineGet(`/invoices/proposal/${id}`)
      .then((res) => { if (gone) return; setMoney({ state: 'ready', payload: res.data }); stamp('money', res); })
      .catch(() => { if (!gone) setMoney({ state: 'failed', payload: null }); });

    return () => { gone = true; };
  }, [id, attempt]);

  // The sheet's onChanged, and the staffing section's own Retry.
  const reloadShifts = useCallback(() => {
    offlineGet(`/shifts/by-proposal/${id}`)
      .then((res) => {
        if (showing.current !== id) return;   // the screen moved to another event
        setShifts({ state: 'ready', rows: Array.isArray(res.data) ? res.data : [] });
        setStale((prev) => ({ ...prev, shifts: res.staleAt || null }));
      })
      .catch(() => {});
    if (refreshBadges) refreshBadges();
  }, [id, refreshBadges]);

  useEffect(() => {
    if (!setHeaderDetail) return undefined;
    setHeaderDetail(proposal ? headerOf(proposal) : null);
    return () => setHeaderDetail(null);
  }, [proposal, setHeaderDetail]);

  const when = useMemo(() => (proposal ? whenOf(proposal) : null), [proposal]);
  const setup = useMemo(() => (proposal ? setupOf(proposal) : null), [proposal]);
  const contacts = useMemo(() => (proposal ? contactsOf(proposal, plan.row) : null), [proposal, plan.row]);
  const staffing = useMemo(() => staffingOf(shifts.rows, proposal), [shifts.rows, proposal]);
  const fin = useMemo(() => (proposal ? financialsOf(proposal, money.payload) : null), [proposal, money.payload]);

  const staleAt = earliestStale(stale.proposal, stale.shifts, stale.plan, stale.money);
  const cachedTime = formatStaleTime(staleAt);
  const liveTime = formatStaleTime(fetchedAt);
  const cancelled = !!proposal && proposal.status === 'archived';
  const toggle = (key) => setPanes((prev) => ({ ...prev, [key]: !prev[key] }));
  const sheetOpen = drawer.kind === 'shift' && /^\d+$/.test(String(drawer.id || ''));

  if (loading && !proposal) return <div className="m-sheet-state">Loading the event</div>;
  if (error && !proposal) {
    return (
      <div className="m-empty" role="alert">
        <div className="m-empty-title">Couldn't load this event</div>
        <div className="m-empty-body">{error}</div>
        <button type="button" className="m-retry-btn" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
      </div>
    );
  }
  if (!proposal) return null;   // dead route: the chrome is already navigating away

  return (
    <div>
      {(cachedTime || liveTime) && (
        <div className="m-stale">
          {cachedTime && <span className="m-stale-dot" aria-hidden="true" />}
          <span>{cachedTime ? 'offline copy · as of' : 'as of'} <span className="m-stale-time">{cachedTime || liveTime}</span></span>
        </div>
      )}

      <div className="m-detail-when">
        <div className="m-detail-whenline">
          {when.text}
          {cancelled && <StatusChip kind="neutral">Cancelled</StatusChip>}
          {!cancelled && when.isToday && <StatusChip kind="accent">Today</StatusChip>}
        </div>
        {setup && <div className="m-detail-setup">{`setup ${setup}`}</div>}
      </div>

      <ContactsSection
        open={panes.contact}
        onToggle={() => toggle('contact')}
        contacts={contacts}
        planState={plan.state}
        clientName={proposal.client_name}
      />

      <section className="m-section">
        <button type="button" className="m-section-row" aria-expanded={panes.staffing} onClick={() => toggle('staffing')}>
          <Icon name="userplus" size={20} />
          <span className="m-section-name">Staffing</span>
          {staffing.count && <span className={FRAC[staffing.state]}>{staffing.count}</span>}
          <Caret open={panes.staffing} />
        </button>
        {panes.staffing && (
          <>
            {shifts.state === 'loading' && <div className="m-section-note">Loading the roster</div>}
            {shifts.state === 'denied' && <div className="m-section-note">Staffing needs staffing access.</div>}
            {shifts.state === 'failed' && (
              <div className="m-fail" role="alert">
                <span className="m-fail-msg">Couldn't load staffing.</span>
                <button type="button" className="m-fail-retry" onClick={reloadShifts}>Retry</button>
              </div>
            )}
            {shifts.state === 'ready' && staffing.groups.length === 0 && (
              <div className="m-section-note">No shifts created for this event yet.</div>
            )}
            {shifts.state === 'ready' && staffing.groups.map((g) => (
              <div key={g.shiftId}>
                {g.showHead && (
                  <div className="m-shift-head">
                    <span className="m-shift-label">{g.label}</span>
                    {g.view.closedReason !== 'cancelled' && (
                      <span className={FRAC[g.view.closedReason ? 'closed' : g.view.full ? 'full' : 'open']}>{g.view.count}</span>
                    )}
                  </div>
                )}
                {g.view.rows.map((row) => (
                  <button key={row.key} type="button" className="m-section-item m-person"
                    onClick={() => drawer.open('shift', g.shiftId, { focus: row.userId })}>
                    <span className={`m-avatar${row.kind === 'rostered' ? '' : ' m-avatar-app'}`} aria-hidden="true">{row.initials}</span>
                    <span className="m-person-main">
                      <span className="m-person-name">{row.name}</span>
                      {row.meta ? <span className="m-person-meta">{row.meta}</span> : null}
                    </span>
                    {row.kind === 'applicant' && <StatusChip kind="warn">Pending</StatusChip>}
                    {row.kind === 'waitlisted' && <StatusChip kind="neutral">Waitlisted</StatusChip>}
                    {row.kind === 'rostered' && <span className="m-person-check"><Icon name="check" size={16} /></span>}
                  </button>
                ))}
                {!g.view.closedReason && !g.view.rosterless && g.view.open > 0 && (
                  <button type="button" className="m-section-item m-assign-row" onClick={() => drawer.open('shift', g.shiftId)}>
                    <Icon name="userplus" size={18} />
                    {`Assign staff · ${g.view.open} open`}
                  </button>
                )}
                {!g.view.closedReason && g.view.rosterless && (
                  <div className="m-section-note">{ROSTERLESS}</div>
                )}
              </div>
            ))}
          </>
        )}
      </section>

      <MoneySection
        open={panes.pay}
        onToggle={() => toggle('pay')}
        fin={fin}
        moneyState={money.state}
      />

      {!cancelled && (
        <section className="m-section">
          <button type="button" className="m-section-row" disabled={!!staleAt}
            onClick={() => setDesktopView('event-detail', true)}>
            <Icon name="pen" size={20} />
            <span className="m-section-name">Edit details</span>
            {staleAt ? (
              <span className="m-edit-note m-edit-note-locked">
                <span className="m-stale-dot" aria-hidden="true" />needs connection
              </span>
            ) : (
              <>
                <span className="m-edit-note">desktop view</span>
                <span className="m-section-caret" aria-hidden="true"><Icon name="right" size={16} /></span>
              </>
            )}
          </button>
        </section>
      )}

      {sheetOpen && (
        <AssignmentSheet
          key={drawer.id}
          shiftId={Number(drawer.id)}
          focusUserId={drawer.focus}
          onClose={drawer.close}
          onChanged={reloadShifts}
          onDead={drawer.close}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run the page test to verify it passes**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/mobile/EventDetailPhone.test.js`
Expected: PASS, 30 tests, and no "not wrapped in act(...)" warning. The header assertions sit inside `waitFor` on purpose: the page hands its header to the chrome in an effect, one tick after the rows paint.

- [ ] **Step 6: Write the class-contract test**

jsdom applies no CSS, so a class a component uses and the stylesheet never defines is invisible to every other test. This one reads the four sources that render this lane's classes.

Create `client/src/utils/mobileClassContract.test.js`:

```js
import '@testing-library/jest-dom';
import fs from 'fs';
import path from 'path';

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const css = read('index.css');
const SOURCES = [
  'components/mobile/AssignmentSheet.js',
  'components/mobile/MobileHeader.js',
  'pages/mobile/EventDetailPhone.js',
  'pages/mobile/EventDetailSections.js',
];

// Every m-* token that appears inside a string or template literal in the
// source. Comments are stripped first so prose cannot add or hide a class.
function classesIn(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...new Set(code.match(/\bm-[a-z][a-z0-9-]*/g) || [])];
}

test.each(SOURCES)('%s uses only classes the stylesheet defines', (rel) => {
  const missing = classesIn(read(rel)).filter((name) => !new RegExp(`\\.${name}(?![a-z0-9-])`).test(css));
  expect(missing).toEqual([]);
});
```

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/mobileClassContract.test.js`
Expected: PASS, 4 tests. A failure names the class: either it is a typo in the component, or Task 5's block is missing a rule, in which case add the rule to the block in `index.css`, add the name to the vocabulary in `mobileDetailCss.test.js`, and say so in the task report.

- [ ] **Step 7: Check the sizes and build**

Run: `wc -l client/src/pages/mobile/EventDetailPhone.js client/src/pages/mobile/EventDetailSections.js && cd client && CI=true npx react-scripts build`
Expected: about 280 and 155 lines; the build exits 0 (its one warning, a missing source map inside the `html2pdf.js` package, predates this lane).

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/mobile/EventDetailPhone.js client/src/pages/mobile/EventDetailSections.js client/src/pages/mobile/EventDetailPhone.test.js client/src/utils/mobileClassContract.test.js && git commit -F - <<'MSG'
feat(phone detail): the event detail screen

The when and setup lines, Contacts as tap targets with the day-of contact,
Staffing grouped per shift, Financials with the bank debit in flight, and an
Edit details row that opens the Desktop view until the edit sheet lands.
Four reads, each allowed to fail alone, each asking for the offline
fallback; the drink plan is read only as its day-of-contact projection.
Only a dead proposal read, or an id that is not a number, dispatches
mobile-route-dead. A staffing reload that lands after the screen moved to
another event is dropped. Adds a class-contract test, because jsdom cannot
see a missing CSS rule.
MSG
```

---

### Task 9: Wire it in: fork `EventDetailPage`, give the list the sheet

**Files:**
- Modify: `client/src/pages/admin/EventDetailPage.js` (imports `:1-34`; the default export `:38`; end of file)
- Modify: `client/src/pages/mobile/EventsListPhone.js` (header comment `:12-20`; imports `:2-10`; the constants `:22-25`; `useDrawerParam()` `:36`; the feed read `:73`; the interim drawer mount `:233-243`)
- Modify: `client/src/pages/mobile/EventsListPhone.test.js` (the `ShiftDrawer` mock `:10-11`; six `/shifts` call assertions; the manual-card test `:146-154`)
- Modify: `client/src/utils/mobileClassContract.test.js` (one more test)
- Test: `client/src/pages/admin/EventDetailPage.fork.test.js` (new)

**Interfaces:**
- Consumes: Task 8b's `EventDetailPhone` and its `mobileClassContract.test.js`; Task 6's `AssignmentSheet`; Task 3's `useDrawerParam({ push: true, kinds })`; Task 3b's `offlineGet`; `useMobileView()` -> `{ isPhone, desktopView(screenKey) }`.
- Produces: `/events/:id` renders `EventDetailPhone` at phone width unless the `event-detail` screen is pinned to Desktop view; a manual shift on the phone list opens `AssignmentSheet`; the desktop `ShiftDrawer` is no longer imported by any file under `client/src/pages/mobile/`; the phone list reads its feed with `offlineGet`, which is what keeps its offline mode now that the service worker serves a stored copy only to a request that asks.

- [ ] **Step 1: Write the failing fork test**

Create `client/src/pages/admin/EventDetailPage.fork.test.js`:

```js
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

// `mock` prefix: babel-plugin-jest-hoist only lets a jest.mock factory close
// over variables named mock*.
const mockMobileView = { isPhone: false, desktopView: jest.fn(() => false), setDesktopView: jest.fn() };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockMobileView }));
jest.mock('../mobile/EventDetailPhone', () => ({ __esModule: true, default: () => <div data-testid="phone-detail" /> }));
// The desktop body is left in its loading state on purpose: this test is about
// which branch mounts, and a read that never lands keeps every heavy card out.
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
// Stable identity: the desktop body's reload callbacks depend on toast, so a
// fresh object per render would re-run its load effect forever.
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));
const mockAuth = { user: { id: 1, role: 'admin' } };
jest.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth }));
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import api from '../../utils/api';
import EventDetailPage from './EventDetailPage';

const mount = () => render(
  <MemoryRouter initialEntries={['/events/13']}>
    <Routes><Route path="/events/:id" element={<EventDetailPage />} /></Routes>
  </MemoryRouter>
);

beforeEach(() => {
  api.get.mockReturnValue(new Promise(() => {}));   // never lands
});

test('phone width without a Desktop-view override renders the phone detail', () => {
  mockMobileView.isPhone = true; mockMobileView.desktopView.mockReturnValue(false);
  mount();
  expect(screen.getByTestId('phone-detail')).toBeInTheDocument();
  expect(mockMobileView.desktopView).toHaveBeenCalledWith('event-detail');
  expect(api.get).not.toHaveBeenCalled();   // the desktop body never mounted
});

test('phone width with the Desktop-view override renders the desktop page', () => {
  mockMobileView.isPhone = true; mockMobileView.desktopView.mockReturnValue(true);
  mount();
  expect(screen.queryByTestId('phone-detail')).toBeNull();
  expect(screen.getByText(/Loading event/)).toBeInTheDocument();
  expect(api.get).toHaveBeenCalledWith('/proposals/13');
});

test('desktop width renders the desktop page', () => {
  mockMobileView.isPhone = false; mockMobileView.desktopView.mockReturnValue(false);
  mount();
  expect(screen.queryByTestId('phone-detail')).toBeNull();
  expect(screen.getByText(/Loading event/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/EventDetailPage.fork.test.js`
Expected: the first test FAILS (`phone-detail` is not rendered; the desktop page mounts at every width). The other two PASS.

- [ ] **Step 3: Fork the page**

In `client/src/pages/admin/EventDetailPage.js`, add to the imports (after the `OutOfAreaKnob` import):

```js
import { useMobileView } from '../../context/MobileViewContext';
import EventDetailPhone from '../mobile/EventDetailPhone';
```

Change the declaration at `:38` from `export default function EventDetailPage() {` to:

```js
function EventDetailPageDesktop() {
```

and append at the end of the file:

```js

// Phone fork (spec 2026-08-13-mobile-admin section 3): one URL, two
// components. At phone width /events/:id renders the phone detail unless this
// screen is pinned to Desktop view. The fork lives here, above the desktop
// body's hooks, so hook order never changes between branches.
export default function EventDetailPage() {
  const { isPhone, desktopView } = useMobileView();
  if (isPhone && !desktopView('event-detail')) return <EventDetailPhone />;
  return <EventDetailPageDesktop />;
}
```

- [ ] **Step 4: Run the fork test to verify it passes**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/EventDetailPage.fork.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Rewrite the list's manual-shift tests**

In `client/src/pages/mobile/EventsListPhone.test.js`, replace the `ShiftDrawer` mock and its comment (`:10-11`) with:

```js
// The sheet has its own suite; here it is a stub that exposes its props.
jest.mock('../../components/mobile/AssignmentSheet', () => ({
  __esModule: true,
  default: ({ shiftId, onClose, onChanged, onDead }) => (
    <div data-testid="sheet">
      <span data-testid="sheet-shift">{String(shiftId)}</span>
      <button type="button" onClick={onClose}>stub close</button>
      <button type="button" onClick={onChanged}>stub changed</button>
      <button type="button" onClick={onDead}>stub dead</button>
    </div>
  ),
}));
```

Replace `LocationProbe` so a test can go Back the way Android does:

```js
function LocationProbe() {
  const l = useLocation();
  const n = useNavigate();
  return (<><div data-testid="loc">{l.pathname + l.search}</div><button type="button" onClick={() => n(-1)}>history back</button></>);
}
```

and add `useNavigate` to the `react-router-dom` import.

The list will read its feed with `offlineGet` (Step 7), which adds a header to every call. Six existing assertions name the call's second argument as `{ params: { ... } }`: in each `toHaveBeenCalledWith('/shifts', { params: { ... } })` and `toHaveBeenLastCalledWith('/shifts', { params: { ... } })`, add `headers: { 'X-Offline-Ok': '1' }` after `params`, so that for example

```js
  expect(api.get).toHaveBeenCalledWith('/shifts', { params: { scope: 'upcoming', limit: 60, offset: 0 } });
```

becomes

```js
  expect(api.get).toHaveBeenCalledWith('/shifts', { params: { scope: 'upcoming', limit: 60, offset: 0 }, headers: { 'X-Offline-Ok': '1' } });
```

Check: `grep -c "X-Offline-Ok" client/src/pages/mobile/EventsListPhone.test.js` prints 7 once the four new tests below are in (six rewritten, one new).

Replace the test `a booked card navigates to the event detail; a manual card opens the shift drawer` with these four:

```js
test('a booked card navigates to the event detail', async () => {
  api.get.mockResolvedValue(env([row()]));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Henderson/ }));
  expect(await screen.findByTestId('detail')).toBeInTheDocument();
});

test('a manual card opens the assignment sheet, and Back closes it without leaving the list', async () => {
  api.get.mockResolvedValue(env([row(), row({ id: 7, proposal_id: null, event_key: 's7', client_name: 'Night Market pop-up', event_type: null, proposal_guest_count: null })]));
  mount('/events?scope=past');
  fireEvent.click(await screen.findByRole('button', { name: /Night Market/ }));
  expect(await screen.findByTestId('sheet-shift')).toHaveTextContent('7');
  expect(screen.getByTestId('loc')).toHaveTextContent('/events?scope=past&drawer=shift&drawerId=7');
  fireEvent.click(screen.getByRole('button', { name: 'history back' }));
  await waitFor(() => expect(screen.queryByTestId('sheet')).toBeNull());
  expect(screen.getByTestId('loc')).toHaveTextContent('/events?scope=past');
  expect(screen.getByText('Night Market pop-up')).toBeInTheDocument();
});

test('a change made in the sheet reloads the list', async () => {
  api.get.mockResolvedValue(env([row({ id: 7, proposal_id: null, event_key: 's7', client_name: 'Night Market pop-up', event_type: null })]));
  mount('/events?drawer=shift&drawerId=7');
  await screen.findByText('Night Market pop-up');
  const before = api.get.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'stub changed' }));
  await waitFor(() => expect(api.get.mock.calls.length).toBe(before + 1));
  expect(api.get).toHaveBeenLastCalledWith('/shifts', { params: { scope: 'upcoming', limit: 60, offset: 0 }, headers: { 'X-Offline-Ok': '1' } });
  // Let the reloaded list land inside the test.
  expect(await screen.findByText('Night Market pop-up')).toBeInTheDocument();
});

test('a dead manual shift closes the sheet and keeps the list where it was', async () => {
  api.get.mockResolvedValue(env([row()]));
  mount('/events?scope=past&drawer=shift&drawerId=999');
  await screen.findByText('Henderson');
  fireEvent.click(screen.getByRole('button', { name: 'stub dead' }));
  await waitFor(() => expect(screen.queryByTestId('sheet')).toBeNull());
  expect(screen.getByTestId('loc')).toHaveTextContent('/events?scope=past');
});
```

- [ ] **Step 6: Run the list suite to verify the new tests fail**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/mobile/EventsListPhone.test.js`
Expected: the three sheet tests FAIL (the list still mounts the desktop drawer, so no `sheet` test id renders), and so do the tests whose `/shifts` assertion you just rewrote (the list does not send the header yet). The tests that assert neither PASS.

- [ ] **Step 7: Swap the drawer for the sheet**

In `client/src/pages/mobile/EventsListPhone.js`:

Replace the import of `ShiftDrawer` (`:10`) with:

```js
import AssignmentSheet from '../../components/mobile/AssignmentSheet';
```

Replace the import of the api client (`import api from '../../utils/api';`, `:3`) with:

```js
import { offlineGet } from '../../utils/offlineRead';
```

and the feed read inside `load` (`const res = await api.get('/shifts', { params: params(offset) });`) with:

```js
      const res = await offlineGet('/shifts', { params: params(offset) });
```

The list renders the staleness line and takes no action on a cache-served copy, so it may ask for the offline fallback. After this edit the file has no other use of `api`.

Add `useOutletContext` to the `react-router-dom` import:

```js
import { useNavigate, useOutletContext } from 'react-router-dom';
```

Replace the second paragraph of the header comment (the one that begins "Manual shifts (no proposal, so no detail page) open the desktop ShiftDrawer") with:

```js
// Manual shifts (no proposal, so no detail page) open the phone assignment
// sheet. The sheet's URL state pushes one history entry, so Android Back
// closes the sheet and stays on the list (spec section 3).
```

Add one constant after the `SKELETONS` line (`:25`):

```js
// The kinds of drawer that are phone sheets here. Module scope: one identity.
const SHEETS = ['shift'];
```

Replace `const drawer = useDrawerParam();` with:

```js
  const drawer = useDrawerParam({ push: true, kinds: SHEETS });
  const { refreshBadges } = useOutletContext() || {};
```

Replace the interim drawer block (the comment that begins "Mounted only while open" and the `ShiftDrawer` element) with:

```js
      {/* Mounted only while open. A dead shift (deleted, or staffing access
          lost) closes the sheet rather than dispatching mobile-route-dead:
          this list IS the fallback destination, and closing keeps its scope
          and chip where the chrome's fallback would reset them. */}
      {drawer.kind === 'shift' && /^\d+$/.test(String(drawer.id || '')) ? (
        <AssignmentSheet
          key={drawer.id}
          shiftId={Number(drawer.id)}
          focusUserId={drawer.focus}
          onClose={drawer.close}
          onChanged={() => { load(0, false); if (refreshBadges) refreshBadges(); }}
          onDead={drawer.close}
        />
      ) : null}
```

- [ ] **Step 8: Extend the class-contract test**

Task 8b created `client/src/utils/mobileClassContract.test.js`. Append one test to it, so the interim never comes back by accident:

```js
test('no file under pages/mobile or components/mobile imports the desktop ShiftDrawer', () => {
  for (const dir of ['pages/mobile', 'components/mobile']) {
    const folder = path.resolve(__dirname, '..', dir);
    for (const file of fs.readdirSync(folder).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))) {
      expect(`${dir}/${file}: ${/drawers\/ShiftDrawer/.test(fs.readFileSync(path.join(folder, file), 'utf8'))}`).toBe(`${dir}/${file}: false`);
    }
  }
});
```

- [ ] **Step 9: Run the three suites and the build**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/pages/mobile src/pages/admin/EventDetailPage.fork.test.js src/pages/admin/EventsDashboard.fork.test.js src/utils/mobileClassContract.test.js && CI=true npx react-scripts build`
Expected: all PASS; `EventsListPhone.test.js` reports 17 tests (14 before, one replaced by four), `mobileClassContract.test.js` 5, and no "not wrapped in act(...)" warning anywhere; the build exits 0 with no warning.

- [ ] **Step 10: Commit**

```bash
git add client/src/pages/admin/EventDetailPage.js client/src/pages/admin/EventDetailPage.fork.test.js client/src/pages/mobile/EventsListPhone.js client/src/pages/mobile/EventsListPhone.test.js client/src/utils/mobileClassContract.test.js && git commit -F - <<'MSG'
feat(phone): fork the event detail and open manual shifts in the sheet

EventDetailPage forks at the top through useMobileView, exactly as
EventsDashboard does, so one URL serves both components. The phone list
drops the interim desktop drawer: a manual shift opens the assignment sheet
with push history, so Android Back closes it and stays on the list. The
list reads its feed with offlineGet, which keeps its offline mode now that
cached reads are opt-in. No file under pages/mobile or components/mobile
imports the desktop drawer now, and a test holds that.
MSG
```

---

### Task 10: Phone-viewport gate and the benchmark comparison

**Files:**
- Modify: `scripts/mobile-capture.manifest.json` (two admin pages)
- No committed Playwright script; the checks below run ad hoc from the lane with `playwright-core` per `.claude/agent-memory/ui-ux-reviewer/local-ui-review-recipe.md`: Chromium from `~/.cache/ms-playwright/`, viewport 390x844, a dev admin JWT minted with `jwt.sign({ userId: 1, tokenVersion: 0 }, process.env.JWT_SECRET)` and planted in `localStorage.token` by `addInitScript`.

**Two warnings before any check runs.**
- **The dev box talks to LIVE Twilio and LIVE Resend.** An approve or an assign against a real staffer texts and emails that person. Every write check below uses a fixture staffer the check creates (email on `example.com`, no phone on the profile) and a fixture shift, and deletes both by id afterwards. Never tap Approve or Assign on a real person's row.
- **An offline RELOAD cannot boot against the dev server** (the CRA dev bundle is unhashed, so the service worker never caches it). Offline is proved in-document: load live, call `context.setOffline(true)`, then navigate inside the app. The cold offline launch is a Pixel-walk item.

- [ ] **Step 1: Add the two pages to the manifest**

Insert after the `admin-events-needs` entry:

```json
    { "name": "admin-event-detail", "host": "localhost", "path": "/events/:token", "auth": "admin", "settleMs": 2600,
      "authAssert": ".m-section",
      "tokenQuery": "SELECT s.proposal_id::text AS token FROM shifts s WHERE s.proposal_id IS NOT NULL AND s.status <> 'cancelled' ORDER BY s.event_date DESC LIMIT 1" },
    { "name": "admin-event-sheet", "host": "localhost", "path": "/events?drawer=shift&drawerId=:token", "auth": "admin", "settleMs": 2600,
      "authAssert": ".m-sheet",
      "tokenQuery": "SELECT s.id::text AS token FROM shifts s WHERE s.status <> 'cancelled' ORDER BY s.event_date DESC LIMIT 1" },
```

- [ ] **Step 2: Run the capture**

With the lane's dev server up: `npm run mobile:check`
Expected: `admin-event-detail` and `admin-event-sheet` report `pass` (no horizontal overflow, nothing painted past the right edge). Read the `taps<36` figure for both: it must be 0. The `tiny<12` figure will not be 0 (the benchmark's own 10px mono labels and 11px meta); record the number and do not chase it. The run may still exit 1 on the pre-existing `portal-home` race recorded in the ma-e1 plan; that is not this lane's.

- [ ] **Step 3: Ad hoc browser checks (REPORT each result with its evidence; the orchestrator writes the Browser checks table on main)**

- D1 header: on `/events/<id>` the header is 60px, the title is an `h1`, `elementFromPoint` at the venue link's centre returns the anchor, its hit area is at least 44px tall, and it carries `target="_blank"`.
- D2 sections: Staffing is open on load, Contacts and Financials closed; each header row is at least 48px tall and `elementFromPoint` at its centre returns the button.
- D2b primary actions (spec section 11): at 390px, `elementFromPoint` at the centre of EACH of these returns the control itself, and each is at least 44px tall: the "Assign staff" row, a staffing person row, "Text", the Edit details row; and in the sheet: Approve, Deny, "Remove from shift", Keep and the confirm button beside it, an "Approve as" role row, an "Assign as" role row, a picker row, and Retry in the failed-save box and in the offline banner.
- D3 contacts: the phone number is a `tel:` link and the Text button an `sms:` link, both at least 44px tall.
- D4 staffing agrees with the desktop: the fraction in the Staffing header equals the "N/M staffed" chip the desktop page shows for the same event (load the same URL at 1280px wide with the same token and read it).
- D5 financials agree with the desktop: the phone's Total and Balance due equal the desktop payment panel's figures for the same event, to the cent.
- D6 sheet opens and Back closes it: tap a staffing row; the URL gains `drawer=shift&drawerId=<id>&drawerFocus=<userId>`; `history.length` grew by exactly one; `page.goBack()` closes the sheet and the URL is `/events/<id>` again, same page, same scroll position.
- D7 deep link: `page.goto('/events/<id>?drawer=shift&drawerId=<shiftId>')` in a fresh tab opens the sheet; `page.goBack()` closes the sheet and stays on `/events/<id>`.
- D8 nothing overlays the sheet: with the sheet open, `elementFromPoint` at the centre of the first roster row, of the search field and of the tab bar's centre returns, in order, the row, the field and the scrim (the tab bar is covered).
- D9 the sheet scrolls, the page behind does not: scroll the sheet body by 400px; `main#main-content` `scrollTop` is unchanged.
- D10 one write, fixture people only: create a fixture staffer and a fixture manual shift with one open Bartender slot; open the sheet from the list; assign the fixture staffer through "Assign as"; assert exactly ONE `POST /api/shifts/<id>/assign` in the network log with body `{ user_id, position: 'Bartender' }`, the roster shows the person with "just assigned", the list card's fraction moved to 1/1, and the tab badge count dropped by one. Then Remove through the confirm: exactly one `DELETE`. Delete the fixtures by id.
- D11 double tap: repeat D10's assign with `page.route` delaying the POST by 2 seconds and two `click()` calls 50ms apart: ONE POST in the log.
- D12 service worker and offline, in-document: first confirm the new worker took over (`navigator.serviceWorker.controller` is set, `caches.keys()` holds an `admin-api-admin-sw-2026-09-29-v9-u<id>` cache and NO name containing `-v8`: the activate sweep ran). Then load `/events/<id>` live, open and close the sheet once (so its two reads are cached), `context.setOffline(true)`, navigate to the list and back into the event: the detail renders with "offline copy · as of" and the dot, Edit details reads "needs connection"; open the sheet: the offline banner shows, Approve, Deny and Remove are disabled, the picker rows read "Offline". `context.setOffline(false)`, tap the banner's Retry: the banner clears.
- D12b desktop is never served a stored copy: at 1280px wide, load `/events/<id>` and open its desktop drawer live, then `context.setOffline(true)` and reload the data (navigate to `/events` and back): the desktop page shows its own load error, NOT yesterday's roster or invoices. `caches.keys()` then `cache.keys()` on the api cache holds no entry whose request lacked the `X-Offline-Ok` header path: concretely, after a desktop-only session in a fresh browser profile the api cache is empty or absent. Repeat the stall case: `page.route` the detail read to delay 6 seconds with a cached phone copy present; the desktop drawer waits for the network and never shows the cached roster.
- D12c the drink plan at rest: after the phone detail has been opened, read every entry of the api cache and assert that no stored response body contains `"token"` under a drink-plan URL, `admin_notes`, or `accessNotes`; the only drink-plan entry is `...?fields=day_of_contact` and its body has the single key `day_of_contact`.
- D13 failed save: with the sheet open and live, `page.route` the assign POST to `abort()`; assign the fixture staffer: "No connection, didn't save." shows under that row with Retry, the sheet stayed open, nothing was written (`SELECT` the fixture shift's requests). Un-route, tap Retry: it lands.
- D14 dead routes: `/events/2147483000` falls back to `/events`; `/events?drawer=shift&drawerId=2147483000` closes the sheet and stays on `/events`.
- D15 Edit details: tapping it shows the desktop event page with the "Phone view" return pill; the pill returns to the phone detail.
- D16 every state the benchmark names, both skins. After Hours and House Lights screenshots, from fixtures the check creates and deletes by id (prod has no upcoming multi-shift event, manual shift or mixed-role roster, and dev may not either). Detail: Staffing open; Contacts open with a day-of contact, and without one; Financials open with a balance, paid in full, and with a bank payment in flight; a two-shift event (heads); the Edit details row unlocked and reading "needs connection"; a cancelled event. Sheet: one open role; two open roles with the "Approve as" rows, and with the "Assign as" rows; a focused applicant; a focused rostered row; the Remove confirm and the Deny confirm; the failed save with Retry; the offline banner; the search field with no match; a manual shift (venue in the head); a past event and a cancelled event (read-only); a shift with no declared roles. In After Hours the Remove button, the confirm border and a failed-save message read RED, not violet: read `getComputedStyle(...).color` and assert `rgb(255, 77, 77)`. In House Lights a section's border is `--line-2` and it casts no shadow. Every distance on the phone is a whole number of miles.
- D17 desktop is untouched: at 1280px, `/events/<id>` renders the desktop page exactly as before and its Manage button still opens the desktop `ShiftDrawer` with replace semantics (`history.length` unchanged by open and close).

- [ ] **Step 4: Benchmark comparison**

Serve the benchmark (`cd docs/design-artifacts && python3 -m http.server 8765`), render Event detail and Assignment sheet at 460x960 in both skins, and lay each state beside the app's screenshot from D16. Then the orchestrator runs the `ui-ux-review` agent with both sets and this instruction: adherence to the artifact is the primary benchmark; every difference is either one of the twenty-two decisions listed at the top of this plan or a finding.

- [ ] **Step 5: Fold what the gate found**

This is the first time Tasks 5 to 9 are seen in a browser, and the last lane needed a fix round here. For each failed check and each ui-ux finding: fix it in the file that owns it (every such file is in the lane footprint), commit by explicit path with a message that names the check (`fix(phone detail): D6 ...`), re-run the suite that file belongs to and the check that failed, and report both results. A fix that would change one of the twenty-two decisions, the contract of Tasks 1 and 3b, or a file outside the footprint is not made in the lane: report it and stop.

- [ ] **Step 6: Commit the manifest**

```bash
git add scripts/mobile-capture.manifest.json && git commit -F - <<'MSG'
test(mobile): phone-viewport capture pages for the event detail and the sheet
MSG
```

---

### Task 11: Docs and ledgers

**Files:**
- Modify: `README.md` (the `client/src/utils/` tree near `:575-579`; the `components/` `mobile/` line `:582`; the `hooks/` line `:619`; the `pages/` `mobile/` line near `:625`; the `server/utils/` tree; Key Features, "Phone Admin PWA", `:709`)
- Modify: `ARCHITECTURE.md` (`:226` the `/active-staff` row; `:453-454` the two shifts rows; `:2041` the Admin PWA service worker paragraph; `:2045` the Phone Events list bullet)
- Modify: `docs/walkthroughs-owed.md` (the Phone Events list entry, `:1787`, and a new entry after it)
- Modify: `docs/fix-list-remaining-2026-07-02.md` (the "Mobile admin: every phone-first DATA screen" entry, `:2074`)
- Modify: `scripts/sensitive-paths.txt` (two client entries)

- [ ] **Step 1: README**

In the `client/src/utils/` tree add, beside `eventCards.js`:

```text
│   │   │   ├── offlineRead.js       # offlineGet: api.get plus the X-Offline-Ok header. The admin service worker stores and stale-serves a read ONLY for a request that carries it; a caller sends it only if it renders the staleness line and takes no action on a cache-served copy
│   │   │   ├── staffingSheet.js     # Pure staffing logic for the phone staffing card and assignment sheet: roster rows, per-role open counts, roleStep (the role an approve or assign may send; never defaults, never infers), picker candidates
│   │   │   ├── eventDetailView.js   # Pure view-model for the phone event detail: header, when and setup lines, contacts as tap targets, staffing groups, financials (follows the desktop payment panel figure for figure)
```

In the `components/` `mobile/` description add `AssignmentSheet the phone ShiftDrawer for one shift (bottom sheet: roster with Approve, Deny, Remove behind confirms, role rows, alphabetical picker with search)` and change the `MobileHeader` clause to mention the rich detail variant. In the `hooks/` line change `useDrawerParam + drawerHref` to `useDrawerParam + drawerHref (replace history by default; { push: true } for phone sheets, so Android Back closes the sheet)`. In the `pages/` `mobile/` line add `EventDetailPhone (the phone event detail at /events/:id: Contacts, Staffing, Financials, Edit details row) with EventDetailSections (its presentational Contacts and Financials sections)`. In the `server/utils/` tree add:

```text
│   │   ├── staffingMeta.js     # Events-worked count and home-to-venue distance for the staffing reads (plain meta, never ranking; pinned to GET /admin/users/:id/seniority by test)
```

In Key Features, "Phone Admin PWA" (`:709`), add one bullet: the phone event detail at `/events/:id` (venue as a map link, contacts as tap-to-call and tap-to-text, staffing per shift, financials with a bank payment in flight) and the assignment sheet (approve, deny, remove and assign from the phone; Android Back closes the sheet; the phone never over-fills a role and never writes a role the screen did not show).

- [ ] **Step 2: ARCHITECTURE**

Append to the `/active-staff` row (`:226`): ` Opt-in \`?shift_id=<id>\` (phone assignment sheet) adds \`events_worked\` and \`home_distance_miles\` (home to THAT shift's venue, in WHOLE miles, null when either side has no coordinates) to every row; raw coordinates never leave the server; 400 on a malformed id, 404 on an unknown shift. Without \`shift_id\` the row shape is frozen (pinned by \`shifts.staffingMeta.test.js\`).`

In the Drink Plans route table, replace the `/by-proposal/:proposalId` row (`:239`) with:

```text
| GET | `/by-proposal/:proposalId` | Admin | Fetch plan linked to a proposal. `?fields=day_of_contact` answers only `{ day_of_contact: { name, phone } | null }`: the phone event detail reads that and nothing else, and it is the only form of this read the admin service worker stores (the full plan carries its write-capable token, internal notes and venue access notes). Any other `fields` value is a 400. |
```

Replace the two shifts rows (`:453-454`) with:

```text
| GET | `/by-proposal/:proposalId` | Staffing | All shifts for a proposal (array, supports multi-shift events). 400 for an id that is not a positive integer. Each shift carries `approved_staff`, `requesters` (every live request with `request_id`, `status`, `position`, `requested_positions`, `events_worked` and the derived `home_distance_miles`), `approved_by_role`, the out-of-area context, and `finished` (past its END INSTANT in the event zone, `shiftFinishedSql`). |
| GET | `/detail/:id` | Staffing | Single shift detail: `{ shift, requests }`. 400 for an id that is not a positive integer. `shift` carries `finished` and `proposal_status`; each request carries `events_worked` and the derived `home_distance_miles`. Read by the desktop `ShiftDrawer` and the phone `AssignmentSheet`. |
```

In the Admin PWA service worker paragraph (`:2041`), rewrite the clause about allowlisted reads so it says all of this: the allowlist is exact paths plus anchored numeric-id patterns (`/api/proposals/:id`, `/api/shifts/by-proposal/:id`, `/api/shifts/detail/:id`, `/api/invoices/proposal/:id`), and `/api/drink-plans/by-proposal/:id` ONLY with the exact query `?fields=day_of_contact`; storing and stale-serving are OPT-IN per request: the worker handles a read only when the request carries `X-Offline-Ok: 1` (sent by `client/src/utils/offlineRead.js` `offlineGet`), or is the identity read `/api/auth/me`; every other request on an allowlisted path goes to the network untouched and is never stored, so desktop screens are never shown a stored copy; pinned by `client/src/utils/adminSwAllowlist.test.js`, which runs the real worker file. Make the same correction in README Key Features, "Offline is a read-only courtesy" (`:711`). In the mobile-admin section:
- Rewrite the end of the Phone Events list bullet (`:2045`): it still says a manual shift opens "the interim desktop `ShiftDrawer` ... (lane ma-e2 swaps in the phone sheet)". It now opens `client/src/components/mobile/AssignmentSheet.js`, with push history.
- Add a Phone event detail bullet: `client/src/pages/mobile/EventDetailPhone.js` is mounted by a route-level fork inside `client/src/pages/admin/EventDetailPage.js` (same URL, `useMobileView()`, screen key `event-detail`); it makes four reads, each allowed to fail alone, and only a dead `GET /proposals/:id` dispatches `mobile-route-dead`; its view-model is the pure `client/src/utils/eventDetailView.js`, which follows the desktop payment panel figure for figure; it hands the chrome its rich header through the outlet context (`setHeaderDetail`, cleared by `AdminLayout` on every route change).
- Add an Assignment sheet bullet naming `client/src/utils/staffingSheet.js` as the phone's role-resolution module and stating its law: the phone never over-fills, never defaults a role, and re-reads the shift before an approve or an assign. Name `server/utils/staffingMeta.js` as the source of `events_worked` and `home_distance_miles`, and say that both are plain meta and that nothing sorts by them.
- Add a sentence on `useDrawerParam`: replace history by default; `{ push: true, kinds }` for phone sheets.

- [ ] **Step 3: walkthroughs-owed**

In the Phone Events list entry (`:1787`), replace the clause "a manual shift opens the drawer (Back leaves the list until the ma-e2 sheet lands)" with "a manual shift opens the assignment sheet and Android Back closes it (the sheet landed with lane ma-e2; walk it with the entry below)".

Add directly after that entry, leaving `<date>` and `<sha>` exactly as written (the orchestrator fills both on main after the merge, when the squash sha exists):

```text
- [ ] **Phone event detail and assignment sheet (lane ma-e2, merged <date>, <sha>).** Pixel, installed PWA, prod data.
      Detail: the header's venue opens Google Maps OUTSIDE the installed app and Back returns to it;
      the client's number dials and the Text button opens Messages; the day-of contact shows when the
      drink plan has one; the Staffing fraction matches the list card; Financials matches the desktop
      panel for the same event to the cent. Sheet: open it from a staffing row and from a manual card;
      Android Back closes it and stays put, every time, including after a cold launch that restored an
      open sheet; airplane mode shows the banner and disables every action; the search field shows ONE
      clear control or none, never two. Do NOT approve, assign or remove on a real person for the walk
      unless that is what you mean to do: each one texts and emails them. Both skins, and in After
      Hours the Remove button reads red, not violet.
      Graduates by this tier's own rule: `git merge-base --is-ancestor <sha> origin/main` exits 0.
```

- [ ] **Step 4: fix list**

In the "Mobile admin: every phone-first DATA screen" entry (`:2074`), add a dated amendment as the entry's second paragraph: the event detail and the assignment sheet are built by lane `ma-e2-event-detail` of `docs/superpowers/plans/2026-09-29-mobile-admin-event-detail.md`; the sheet component and the push-history Back behaviour now exist; still declared and unbuilt: `ma-e3-edit-sheet`, `ma-f1-proposals-list`, `ma-f2-proposal-detail`, `ma-f3-search`. Then add nine new items to the list, each one line with its source:
  - Deny sends the staffer nothing (no text, no email); the phone confirm says so. If a denial should notify, that is a change to `server/routes/shifts.approval.js` (sensitive) and a copy change on the phone (ma-e2 plan, Decision 1).
  - `events_worked` now has three readers (`autoAssign.js`, the seniority route, `staffingMeta.js`) held together by one test; fold the two older ones onto `loadEventsWorked` (ma-e2 plan, Task 1).
  - The phone cannot remove a no-show from a finished event (past rosters are read-only there by design); the desktop drawer can (ma-e2 plan, Decision 5).
  - Reads the phone stores still carry public tokens the phone never uses: `token` on `GET /proposals/:id` and on each invoice of `GET /invoices/proposal/:id`, `proposal_token` on `GET /shifts/detail/:id` and on the events feed. No rotation path exists for proposal, invoice or drink-plan tokens, so a token on a lost phone stays valid. Fix: phone projections without tokens (the two files are sensitive), and a way to reissue a token (ma-e2 Checkpoint A, L2).
  - Nothing in the phone's cache ages out: entries live until logout, a user change or the next service worker version (ma-e2 Checkpoint A, L3).
  - Removing `can_staff` from a manager evicts only the exact URL that answers 403; other cached rosters are still served to that phone on a transport failure (ma-e2 Checkpoint A, L4).
  - OWNER DECISION, pre-existing, outside this lane: `GET /api/admin/users/:id` returns a staffer's `street_address`, `zip_code`, `lat` and `lng` to ANY manager. The staffing reads strip coordinates on the ground that nobody sees a staffer's home address; that is true of those reads and not of the codebase (ma-e2 Checkpoint A, L7).
  - The phone list reloads from the top after a change made in the sheet, which loses the scroll position spec section 9 promises. Reload the loaded window in place instead (`limit` = the number of events on screen, capped at the feed's 200). Only manual shifts reach the sheet from the list, and prod has none upcoming, so it waits (ma-e2 plan fleet, 2026-09-29).
  - The event note (spec section 4: "a plain textarea that behaves with Android dictation") is drawn nowhere in the 2026-09-15 benchmark and declared in no lane. It has its own endpoint (`PATCH /proposals/:id/notes`), so it needs no money hydration; decide at the ma-e3 design pass whether it rides the edit sheet or gets a row of its own (ma-e2 plan, Self-Review).

- [ ] **Step 5: sensitive paths**

The phone's role resolution decides the `position` that is written to the payroll seam, so a change to it must draw the full fleet. Append to `scripts/sensitive-paths.txt`, in the client block beside `client/public/admin-sw.js` (`:382`), with a comment line above them in the file's own style:

```text
# Phone staffing (lane ma-e2): roleStep decides the position an approve or an
# assign writes, and the sheet is the only phone surface that writes it.
client/src/utils/staffingSheet.js
client/src/components/mobile/AssignmentSheet.js
# offlineGet is the gate on what the admin service worker may store on a
# device and serve as a stale copy; staffingMeta reads home coordinates and
# seniority and decides how precisely a distance leaves the server.
client/src/utils/offlineRead.js
server/utils/staffingMeta.js
```

Run: `node --test scripts/sensitive-match.test.js`
Expected: PASS, unchanged count.

- [ ] **Step 6: Commit**

```bash
git add README.md ARCHITECTURE.md docs/walkthroughs-owed.md docs/fix-list-remaining-2026-07-02.md scripts/sensitive-paths.txt && git commit -F - <<'MSG'
docs(mobile): event detail, assignment sheet, staffing meta reads, owed walk

Also lists the phone role-resolution module and the assignment sheet as
sensitive paths: they decide the position written to the payroll seam.
MSG
```

---

### Task 12: Lane close: suites reached, gate, review fleet, merge

- [ ] **Step 1: Server suites, one at a time from the repo root**

```bash
TZ=UTC node --test server/routes/shifts.staffingMeta.test.js
TZ=America/Chicago node --test server/routes/shifts.staffingMeta.test.js
for f in server/routes/shifts.*.test.js; do echo "== $f"; node --test "$f" || break; done
node --test server/routes/drinkPlans.dayOfContact.test.js
node --test server/routes/drinkPlans.beo.test.js
node --test server/routes/drinkPlans.shoppingListStrip.test.js
node --test server/routes/admin/users.activeStaff.test.js
node --test server/routes/admin/users.seniority.test.js
node --test server/utils/autoAssign.seniority.test.js
node --test server/routes/eventDetails.test.js
node --test server/routes/invoices.pendingPayment.test.js
```

The `for` loop runs the suites in sequence, never in parallel. Read every pass count and compare each with the same suite on `main` before the lane was cut. A suite whose pass count dropped without a failure lost its database connection.

- [ ] **Step 2: Client suites and the build**

```bash
cd client && CI=true npx react-scripts test --watchAll=false src/utils src/hooks src/components/mobile src/pages/mobile src/pages/admin/EventDetailPage.fork.test.js src/pages/admin/EventsDashboard.fork.test.js src/context && CI=true npx react-scripts build
```

Expected: all PASS, the build exits 0 with no warning. If `EventsListPhone.test.js` fails on "scroll offsets are saved only after the loaded list has been restored", re-run that file alone before reading it as a regression (see the header).

- [ ] **Step 3: Static gates**

```bash
npm run check:css-scope && npm run check:filesize && git diff --name-only main...HEAD
```

Expected: no scope violation; no file newly RED; every path in the diff appears in the lane footprint at the top of this plan. A path outside the footprint stops the lane: report it. Either it does not belong in the change, or the orchestrator amends the footprint on main first, with the reason.

- [ ] **Step 4: Desktop regression by eye**

Dev server, 1280px: `/events/<id>` renders the desktop page as before; Manage opens the desktop drawer; approve, deny and remove work there against a fixture staffer; the Staff roster (`/staffing`), the reviews page and the legacy AdminDashboard staff tab still list staff (they read `/admin/active-staff` without `shift_id`).

- [ ] **Step 5: Review fleet, per the lane map**

Run by the orchestrator: code-review, consistency-check, security-review, database-review, performance-review and ui-ux-review over `git diff main...HEAD`, each told to read its definition under `.claude/agents/` first, plus `/second-opinion` on the same diff. Briefs carry: the twenty-two decisions at the top of this plan, the Review Focus list, the two colour laws, for security-review the questions from Checkpoint A plus "can any tap on the phone write a `position` the screen did not show, and can any path over-fill a role", and for performance-review the second round trip on the two shifts reads, the three queries behind `?shift_id=`, and the sheet's pre-flight read before every approve and assign. A failed or incomplete agent is never a pass: re-dispatch once, then split the diff. Fix rounds as needed, then a re-confirm on the fixed files. The orchestrator records the as-built deltas in this plan's "Lane review round" section, on main, before the merge.

- [ ] **Step 6: Merge**

From `os` on `main`, with a clean tree for the lane's paths: `scripts/merge-lane.sh ma-e2-event-detail`. Re-run Steps 1 and 2 on merged `main`. Then `npm run worktree:rm ma-e2-event-detail`, fill `<date>` and `<sha>` in the walkthroughs-owed entry (on main, as its own commit), and add the board line through `scripts/board-write.sh`. The push is Dallas's call and is not part of this lane.

---

## Self-Review (2026-09-29)

1. **Spec coverage.** Section 3 fork: Task 9. Section 3 push-history sheets ("Back closes an open sheet, always"): Task 3, exercised in Tasks 8b, 9 and the gate (D6, D7). Visual contract, the 2026-09-15 design-session decisions and the 2026-09-29 plan decisions for Event detail, Staffing card and Assignment sheet: Tasks 5, 6, 8a, 8b, judged in Task 10 Steps 3 and 4. Section 4 Detail header (venue link opens externally, tap-to-call and tap-to-text): Tasks 7, 8a, 8b, D1, D3, and the Pixel walk for the installed-app behaviour. Section 4 role selection ("never defaulted, never a dropdown, never inferred"): Task 4 `roleStep`, Task 6. Section 4 candidate list (alphabetical, same feed, waitlist derived by the client module): Tasks 1, 4, 6. Section 7 offline (staleness line, allowlist, writes never queue, a failed save keeps the sheet open): Tasks 2, 6, 8b, D12, D13. Section 9 dead-route fallback: Task 8b (proposal), Tasks 6 and 9 (sheet), D14. Section 10 inline errors with retry, server message surfaced, `err.status` never `err.statusCode`: Tasks 6, 8b; the Sentry surface tag is inherited from `AdminLayout` (Proven context), and a refused write is a handled outcome shown to the user, not an exception, so nothing here captures one (the server reports its own 5xx). Section 11 per-screen gate, with `elementFromPoint` on the primary actions: Task 10 (D2b). Docs law: Task 11. Out of this lane and declared: the edit sheet and its structured edits (ma-e3), the activity feed and the desktop page actions (Desktop view, by the 2026-09-15 decision that supersedes section 4's four-block list). Out of this lane and declared NOWHERE: the event note textarea of section 4, which the benchmark never drew; Task 11 puts it on the fix list for the ma-e3 design pass instead of quietly assigning it.
2. **Placeholder scan.** No TBD. Two `<date>` and `<sha>` markers in Task 11 Step 3 are left as written by the implementer and filled on main after the merge (Task 12 Step 6), because the squash sha does not exist before it.
3. **Type consistency.** `buildShiftView` returns the `ShiftView` fields Task 6 and Task 7 read (`rows, openRoles, openLabel, mix, rolesLabel, pills, count, closedReason, rosterless, full, open, slots, filled`). `roleStep` returns `blocked | direct | pick` in Task 4 and is switched on by those three names in Task 6. `normalizeRequest` accepts both request shapes Task 1 produces. `useDrawerParam` returns `{ kind, id, focus, open, close }` in Task 3 and is destructured that way in Tasks 8b and 9; `open(kind, id, { focus })` has one signature; both callers pass `{ push: true, kinds: SHEETS }`. `AssignmentSheet`'s five props are the same in Task 6, in both stubs (Tasks 8b and 9) and at both mounts. `headerOf` returns the object `MobileHeader` renders as `detail`; `contactsOf` returns both phones formatted, which is what Task 8b's test reads. The server field names (`events_worked`, `home_distance_miles`, `requested_positions`, `finished`, `proposal_status`) are spelled the same in Task 1's test, its SQL, and the client modules that read them. The screen key `event-detail` matches `screenKey.js`.
4. **Review Focus.** Each of the five lines names its pinning test; all five tests exist in the named tasks.
5. **Known judgment calls, stated.** The pre-flight re-read narrows the over-fill race to milliseconds and does not close it (the server still accepts an over-fill; closing it is a change to a sensitive handler). `events_worked` gains a third reader instead of a refactor of the two existing ones, held by a test, with the refactor on the fix list. The sheet reloads the list from the top after a change, as the interim drawer did; the in-place reload is on the fix list. `TODAY` and the year on the when line use the device day, like the list. The benchmark's 10px and 11px type is kept; the capture's tiny-text count is recorded, not chased. The "Approve as" label sits 2px lower than drawn, because one label class serves both role-row blocks.
6. **Plan fleet, 2026-09-29 (fidelity, decomposition, feasibility; all three FAIL; 9 blockers of which 5 distinct, 34 warnings, 24 suggestions; folded).** Two of the three reviewers applied this plan's code to a scratch copy of the client and ran it. What they found, and what changed:
   - **Would not have passed as written.** The day-of phone came back unformatted from Task 7 while Task 8's test read it formatted, and the fix sat in a file Task 8's implementer did not own (now formatted at the source, with its own test). Two header assertions read the hand-off before its effect had flushed (now inside `waitFor`). Two test files were missing from the lane footprint, which the lane's own gate would have caught after eleven tasks (added).
   - **Wrong expectations.** Both components were over the plan's own 330-line limit as written, so both "split if it grows" fallbacks would have fired into files the plan gave no code for (the limit is 400, the fallbacks are gone). Task 3's "verify it fails" step named the wrong tests. Three tests ended while a write's continuation was still pending (16 act warnings; zero now).
   - **Real defects in the code.** An approval with no role on file did not fill a slot, so the phone would have offered a filled slot again (none in prod, 83 of 83 carry a role; now counted). A failure box outlived the action it belonged to, so Retry could repeat a stale write (cleared now). A sheet entry with nothing behind it could never be closed; a desktop drawer link opened on the phone gained a history entry for a sheet that did not exist (the hook now checks its position and takes a list of sheet kinds). `shift_id` above int4 answered 500. A bad date or amount rendered a dash glyph through the shared formatters. A staffing reload could land on the wrong event.
   - **Unrecorded departures from the benchmark.** Seven (contacts as tap targets, cents, the when line, the per-shift head, the cancelled event, the banner's Retry, roster order) are now Decisions 12 to 18 and in the spec. The light skin's section border, the 12px fraction, the 6px payment rows and the uppercase dates now match the benchmark. Rows inside a detail section no longer ship the sheet's row class.
   - **Structure.** Task 8 is two tasks (the chrome change has its own commit and review). The class-contract test moved to the task that owns the files it reads. Checkpoint A's brief moved to the header and gained the at-rest payload question. Implementers report; the orchestrator writes the plan. performance-review joined the fleet. The browser gate gained a fix step, probes on every primary action, and every state the benchmark names. The docs task gained five missing updates and the two sensitive-path entries.
   - **After the fold,** measured in a scratch copy of the client with every code block in this plan applied: 19 suites, 334 tests, all passing, no act warning; the CRA lint clean on the nine changed sources; `CI=true react-scripts build` exit 0. Task 1's server suite was checked statically (columns, constraints, aliases, the composed SQL) and not run, because it seeds the shared dev database; it runs for the first time in the lane.

7. **Checkpoint A, 2026-09-29, run on the built Tasks 1 and 2 (`648a4f32..c6400e3c`), with the three task reviews.** Tasks 1 and 3 passed review clean; Task 2 was approved with one plan-level Important finding.
   - **database-review: PASS**, on the dev branch, read-only. An index leading with `user_id` already exists on `shift_requests`; `loadEventsWorked` runs in 0.2 ms warm; the by-proposal join folds to one primary-key lookup; `finished` is computed per row; the three definitions of events worked disagree for none of the 103 dev users; every new field arrives as a number or a boolean, never a string or NULL.
   - **security-review: FAIL, narrowly.** Who can read the new fields, raw coordinates, `shift_id` as a probe, the allowlist patterns (47 adversarial URLs) and writes all held. What failed: the WHOLE drink plan was being stored on the phone to show two fields, and that payload carries the plan's write-capable token, the internal notes, and the venue access notes whose own placeholder asks clients for gate codes. Now a projection (Decision 21).
   - **The Task 2 review's finding,** confirmed by the security review: the service worker controls every page on the admin origin, so the three reads this lane allowlisted would have reached the desktop payment panel and the desktop staffing drawer as unlabelled stored copies, under their action buttons. It has been true of `/api/proposals/:id` since ma-b. Now opt-in per request (Decision 20).
   - **Also folded:** whole-mile distances (Decision 19); the anchored by-proposal entry; 400 for a malformed id on the two shifts reads and a dead route on the phone (Decision 22); the hook's seed limited to a numeric sheet id; StrictMode, pop-versus-replace and default-close tests for the hook; fixtures that trip each filter of the events-worked definition (a drop, a pending, a denied, tonight), a requester with no contractor profile, and one staffer on two shifts of one event.
   - **Accepted, on the fix list:** tokens at rest that the phone never uses and that cannot be reissued; no ageing of cache entries; a permission downgrade that purges one URL. **Surfaced to Dallas as an owner decision, pre-existing and outside the lane:** `GET /api/admin/users/:id` returns a staffer's street address and coordinates to any manager.
   - **Verification after this fold,** in a scratch copy of the client with every code block applied from this plan's text: the lane's twelve test files, 327 tests, all passing, no act warning; lint clean; `CI=true react-scripts build` exit 0. The server files were syntax-checked and the edits applied to copies of the real files; the two server suites run for the first time in Task 3b.

## Browser checks (lane ma-e2)

Written by the orchestrator from Task 10's report, on main, before the merge.

| check | result | evidence |
|---|---|---|
| D1 to D17 | | |

## Lane review round, as-built deltas (ma-e2)

Written by the orchestrator from the fleet's verdicts and the fix rounds (Task 12 Step 5), on main, before the merge.
