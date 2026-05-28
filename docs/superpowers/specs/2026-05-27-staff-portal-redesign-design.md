# Staff Portal Redesign

**Date:** 2026-05-27
**Status:** Design, awaiting review
**Type:** Whole-surface staff portal redesign + supporting backend.

## 1. Goal

Replace the existing fragmented staff portal (7 separate pages: StaffDashboard, StaffShifts, StaffEvents, StaffSchedule, StaffProfile, StaffResources, MyTipPage) with a coherent 4-tab portal (Home / Shifts / Pay / TipCard) plus an AccountPage overlay covering profile, payment methods, calendar sync, notifications, and documents. The BEO surface (`docs/superpowers/specs/2026-05-25-beo-design.md`) embeds inside the new ShiftDetail page rather than living at a separate `/staff/events/:proposalId/beo` route. New supporting backend: notification preferences with per-channel routing, push notifications, drop / cover marketplace for shifts, ICS calendar feed, payment-methods data model split into tip vs payroll, document replace flow with silent history, alcohol-cert expiry tracking, and theme persistence.

## 2. Why

- The existing staff portal grew page-by-page with no shared shell. Bartenders open Dashboard for the greeting, Shifts for what they're working, Events for the BEO content (currently a stub), Schedule for the calendar grid, Profile for personal info, Resources for the field guide and support links, and MyTipPage for the QR sign. Same data lives in different places; the action a bartender needs ("Did I confirm tomorrow's BEO?") is buried.
- The pivot from a standalone BEO page to embedding BEO inside ShiftDetail removes a redundant surface. A bartender's mental model is "I have a shift on Saturday, what do I need to know?" Not "Where's the BEO?" The shift is the unit.
- The drop / cover marketplace is a real workflow gap today. The SMS `CANT` keyword only drops the nearest upcoming shift; staff cannot drop a specific shift weeks in advance from the portal at all. The result is shifts that need to be off-loaded going through Dallas as one-off SMS exchanges. With a structured drop / cover flow on the staffer side and management notifications, the load on Dallas drops.
- Push notifications, calendar sync, and the documents library are operationally useful and reduce SMS spend. The Account redesign also resolves a long-standing PII pattern: legal name is now read-only because the signed contractor agreement was issued under that name; staff edits there would have invalidated the signed doc.
- The 4-tab model with a user-pill overlay is the dominant mobile-app pattern (Uber, DoorDash, Square Team) and is what bartenders already expect. Matching expectations is leverage.

## 3. Decision record

Settled through brainstorming over the v4 → v6 design iterations:

### 3.1 Topology

- 4 top-level tabs: **Home**, **Shifts** (Available / Mine / Past sub-tabs), **Pay**, **Tip Card**. No other tabs. Schedule, Profile, Resources, MyTipPage are absorbed into these or moved behind the user-pill menu.
- Topbar user-pill is a dropdown menu (avatar + name on the pill, click opens the menu). Menu contains the **Lighting** theme toggle (House lights / After hours), Edit profile, Calendar sync, Notification preferences, Get support, Sign out. Each menu item that opens an Account section navigates to the AccountPage overlay at the right sub-section.
- **AccountPage** is an overlay route within the staff portal shell (not a different URL space), with a back button that returns to wherever the user was. Header is the user's avatar + name + role + email; below is a horizontal scrolling tab bar (5 tabs: Profile, Payment methods, Calendar sync, Notifications, Documents); below that is the active sub-section body; at the bottom, a full-width Sign out button and a help-email footer line.
- **ShiftDetail page** absorbs the BEO. No standalone BEO route exists in the staff portal. The Confirm action and all the drink / addon / notes content the BEO spec describes live here.

### 3.2 Roles and naming

- The "Lead" role badge is dropped from the team roster. Seniority is unspoken among the existing team. The three role labels that ARE shown when applicable: Bartender, Server, Barback.
- Staff names on shared surfaces (team roster, cover broadcasts, Home Needs you tray) render as **first name + last initial** (e.g., "Rosa M."). Full legal name appears only on the Account Profile section.
- "Lead" in the emergency-drop modal copy is renamed to "management." The "Call Stephen first" footer is removed entirely.

### 3.3 Drop / Cover marketplace

Time-to-event drives mode. Boundaries are computed in hours, not day-rounded:

- **>= 14 days (336 hours) out**: clean drop. The staffer's `shift_request` is denied automatically, the shift returns to the open pool, no admin gate. Management is notified by email.
- **72 hours to under 14 days**: cover broadcast. The staffer requests a cover; the shift gets a `cover_requested_at` stamp. Cover-needed badge appears on Shifts/Available for the team and in Home "Needs you" for everyone. First teammate claim triggers a management one-click approve of the swap. The original staffer stays on the roster until covered. Management notified by email; **if <= 7 days out, also by SMS**.
- **< 72 hours**: emergency. Requires a reason text (min 10 chars). The original staffer stays on the roster. Management is notified by email and SMS immediately; management resolves manually (may suspend the staffer per `users.onboarding_status='suspended'`, may waive). Repeated late-drops affect future bookings (policy, not auto-enforced).

### 3.4 Payment methods

- Card payments (Apple Pay / Google Pay / credit) on the public `/tip/{slug}` page settle through the platform's Stripe account (existing flow). Bartender's portion flows into the existing `payout_events.card_tip_net_cents` line. **Not** per-bartender Stripe Connect.
- Payment methods data splits into two categories: **tip-eligible** (Venmo, Cash App, PayPal, Zelle, plus a non-editable "Card payments" always-on row) and **payroll-only** (Check, Direct deposit). Some methods (Venmo / Cash App / PayPal / Zelle) are tip-eligible AND can also be selected as the preferred payroll target. Card payments are tip-eligible only; Check and Direct deposit are payroll-only.
- One **"Preferred for payroll"** setting per staffer. There is NO "preferred for tips" because the QR card scans to a chooser page (`/tip/{slug}`) showing all handles in the bartender's chosen display order. No single tap-through target.
- Drag-to-reorder for the tip card display order lives on the Tip Card page, NOT on the Account / Payment methods page. Order controls what guests see first on the printed card and on the `/tip/{slug}` chooser.
- Typo disclaimer in the Payment methods footer: *"Card payments settle through Dr. Bartender and appear as card_tip_net_cents on your paystub. It's your responsibility to enter handles correctly. Payments sent to typos are not our liability."*

### 3.5 Documents

- Two sections: **Reference** (org-wide) and **My documents** (personal). A third small section, **Other archives**, links to Paystubs for cross-navigation.
- **Field Guide** is rendered as an in-app link to the existing `/field-guide` React route. Not a downloadable PDF. Row has a single "View" action, no file-size or updated-date metadata. Service SOPs (originally a separate row) are rolled into Field Guide's sub-line copy.
- **Brand kit** is cut from v1. The asset does not exist yet. Row is added when content is produced.
- **W-9** and **Alcohol certification** (renamed from "BASSET certificate" for cross-state generality; backend column name `alcohol_certification_*` stays) are replaceable. Tapping Replace opens a file picker, then a confirm modal. The previous file is preserved silently (no mention to the staffer). Admin's existing DocumentsTab can surface the history. Independent Contractor Agreement is NOT replaceable (signed legal doc).
- **Alcohol certification expiry**: meta line shows "Expires [date]." Within 60 days of expiry, an amber "Expires soon" tag plus a nudge sub-line below the row. After expiry, a red "Expired" tag. No automated admin notification on these transitions in v1.
- **No admin notification on replace** for either doc.

### 3.6 Notifications

- 8 categories × 3 channels matrix on AccountPage / Notifications:
  - New shifts I qualify for (SMS, Email, Push)
  - Request approved or denied (SMS, Push)
  - **Cover needed** (Push only by default), added per the drop/cover marketplace
  - BEO ready to confirm (SMS, Email, Push)
  - 3 days out reminder (SMS, Push)
  - Schedule changes (SMS, Email, Push)
  - Payday (SMS, Email)
  - Tips received (Push only by default)
- Each cell is a per-staffer opt-in / opt-out toggle.
- Push enablement triggers the browser `Notification.requestPermission()` flow. UI handles four states: granted (green banner), denied (red banner with re-enable instructions), unsupported (toggles disabled), iosNeedsInstall (banner + coachmark with 3-step "Add to Home Screen" guide).
- Footer copy: *"Critical-path messages. BEO finalized, schedule changes, payday, can't be fully muted. We'll deliver them through whatever channel is still on."* Backend honors this: if all channels are off for a critical category, the dispatcher picks one channel and sends anyway.

### 3.7 Theme

- "Lighting" segmented toggle in the user-pill menu. Two states: House lights (light) / After hours (dark). Flips a `data-skin="light|dark"` attribute on the document root; CSS reads from skin-aware tokens.
- Persistence: stored on the user account (`users.ui_preferences.theme`), not localStorage. Follows the staffer across devices.
- Default for a brand-new account follows the OS `prefers-color-scheme`. Once the user picks explicitly, that choice wins forever, ignoring OS changes.

### 3.8 Calendar sync

- The existing ICS feed at `GET /api/calendar/feed/:token` (`server/routes/calendar.js:287`) is the one we extend; no new feed route. The feed already serves the staffer's confirmed shifts as VEVENT entries. This spec adds all-day VEVENT reminders 3 days before any unconfirmed BEO. Feed refresh interval is the existing `Cache-Control: private, max-age=300` (5 min) header. Past-shift roll-off after 30 days is NEW behavior (the existing feed has only a forward `+ 365 days` window at `calendar.js:307,319`); this spec adds the backward 30-day cutoff at the same time.
- Account / Calendar sync section shows three one-tap subscribe buttons (Google Calendar, Apple Calendar, Outlook) deep-linking to the calendar app with the feed URL pre-loaded, plus the raw URL with a Copy button, plus a last-sync status block (which calendar app, how long ago, event count).
- The token is the existing `users.calendar_token UUID UNIQUE DEFAULT gen_random_uuid()` (separate from the tip-page token, which lives on `payment_profiles.tip_page_token` and is only assigned when the staffer activates tipping). Rotation via the existing `POST /api/calendar/token/regenerate` route.

## 4. Non-goals

- No per-bartender Stripe Connect. The platform continues to handle card-tip collection and disbursement via the existing payroll flow.
- No availability windows / blackout dates. Workforce is fully part-time and on-call; admin asks, staff says yes or no on the spot.
- No in-portal chat with admin. SMS remains the primary out-of-band channel.
- No time clock / clock-in. Hours are scheduled, not punched.
- No shift handoff notes between leads. The team roster + the BEO notes section cover this informally.
- No post-event surveys / debriefs. Out of scope.
- No design changes to admin-side surfaces beyond what BEO already specs (EventDetailPage View BEO link, per-staffer Confirmed pills).
- No onboarding flow changes. Applicant pages stay separate from the staff portal.
- No PWA install prompt or app-store packaging in v1. The staff portal is a web app; iOS users who want push can Add to Home Screen, which is the existing pattern.

## 5. Current mechanism (verified)

### 5.1 Existing staff portal surfaces

`client/src/pages/staff/` today contains: `StaffDashboard.js` (122 lines, greeting + tiles), `StaffShifts.js` (182 lines, list of shifts available for request), `StaffEvents.js` (events the staffer is approved on), `StaffSchedule.js` (161 lines, calendar grid view), `StaffProfile.js` (101 lines, personal info + emergency contact + equipment ownership), `StaffResources.js` (130 lines, quick links + calendar sync stub + support), `MyTipPage.js` (large; QR card + handles editor + tips history), plus `PrintTipCard.css`, `PrintTipCard.jsx`, `PrintTipCard.layouts.jsx`. The wrapper `client/src/components/StaffLayout.js` provides the chrome.

### 5.2 BEO backend (already specced)

`docs/superpowers/specs/2026-05-25-beo-design.md` covers the BEO domain in full: `drink_plans.finalized_at` + `finalized_by`, `shift_requests.beo_acknowledged_at`, the `beo_unack_nudge_sms` dispatcher handler, the `SuppressMessageError` dispatcher contract, the `POST /api/drink-plans/:id/finalize` + `/unfinalize` + `GET /api/beo/:proposalId` + `GET /api/beo/:proposalId/logo` + `POST /api/beo/:proposalId/acknowledge` routes, the lock-when-finalized guards across drinkPlans.js and drinkPlanConsult.js, the suppression hooks on every shift-mutation path, the autoAssign.js ack-clear, the staffShiftHandlers / rescheduleProposal extensions, and the rate-limiter additions. The BEO endpoints feed the new ShiftDetail page directly. **This spec inherits all of that as-is.** The frontend tasks change (Task 29's standalone StaffBeo.js is dropped, Task 31's badges on StaffShifts/StaffEvents are dropped because those pages are replaced; the EventDetailPage View BEO link and per-staffer Confirmed pills survive).

### 5.3 Staff payments backend (already shipped)

Merged to main 2026-05-25 (`089b9cd Merge branch 'staff-payments'`). Shipped: `pay_periods`, `payouts`, `payout_events`, `payout_events.shift_id`, gratuity-split logic, `card_tip_*_cents` columns, late-tip roll-forward, auto-clawback on refund / dispute, processing → paid lifecycle, mark-paid action with method-aware QR + deep link. Existing endpoints (GET payouts list / detail) feed the new Pay tab and PayoutDetail.

### 5.4 Tip-card token + handles

`MyTipPage.js` shipped against `payment_profiles.tip_page_token UUID` (nullable; only set when the staffer activates tipping) + `payment_profiles.tip_page_active BOOLEAN`. Public route `GET /tip/:token`. Server route `GET /api/me/tip-page` at `server/routes/me.js:70` projects token, active flag, all handle columns (`venmo_handle`, `cashapp_handle`, `paypal_url`, `stripe_payment_link_url`), `preferred_payment_method`, and a monthly tip count from `tips`. The token is permanent once assigned and printed on physical QR cards; this spec keeps that contract intact and extends the same route with the additional fields the new TipCardPage needs.

### 5.5 Schema fields already in place

What is actually in the codebase as of this branch (verified against `server/db/schema.sql` and route files):

**Contractor profile data** lives on `contractor_profiles`: `preferred_name`, `phone`, `email`, `birth_month/day/year`, `city`, `state`, `street_address`, `zip_code`, `emergency_contact_name` + `_phone` + `_relationship`, `alcohol_certification_file_url` + `_filename`, `resume_file_url` + `_filename`, `headshot_file_url` + `_filename`, equipment booleans, `travel_distance`, `reliable_transportation`. Mailing address is a composite of four columns (`street_address`, `city`, `state`, `zip_code`); the staff-portal Profile UI renders one address field but the backend reads/writes all four.

**Staff payment data** lives on `payment_profiles` (one row per user, NOT on `contractor_profiles`). Existing columns: `preferred_payment_method TEXT` (values like `'venmo'`, `'cashapp'`, `'paypal'`, `'direct_deposit'`, `'check'`), `payment_username VARCHAR(255)`, `routing_number VARCHAR(255)`, `account_number VARCHAR(255)` (both store AES-256-GCM ciphertext via `server/utils/encryption.js`; columns were originally `VARCHAR(20)` / `VARCHAR(30)` and widened to `VARCHAR(255)` near schema line 1992 when encryption shipped), `w9_file_url VARCHAR(500)`, `w9_filename VARCHAR(255)`, `venmo_handle TEXT`, `cashapp_handle TEXT`, `paypal_url TEXT`, `tip_page_token UUID` (nullable), `tip_page_active BOOLEAN DEFAULT TRUE`, `stripe_payment_link_url TEXT`, `stripe_payment_link_id TEXT`. The W-9 file lives on `payment_profiles`, NOT `contractor_profiles`. This spec adds one column (`zelle_handle TEXT`) and reuses everything else, no new payment-methods table.

**Legal name** lives on `applications.full_name` (NOT NULL) and on `agreements.full_name` (the signed contractor agreement). It is NOT on `contractor_profiles` or `users`. Reading requires a LEFT JOIN through `applications`.

**`users.notification_preferences`** ALREADY EXISTS as a NOT NULL JSONB column (`server/db/schema.sql:2232`) populated with a default of 11 admin-side notification category booleans (urgent_booking, urgent_consult, urgent_staffing, urgent_client_reply, payment_failure, feedback, system_error, routine_admin, routine_thumbtack, routine_hiring, routine_finance). The endpoints `GET /api/me/notification-preferences` (auth) and `PATCH /api/me/notification-preferences` (`requireAdminOrManager`) exist at `server/routes/me.js:210` and `:227`. **Staff are not notification recipients today through this surface.** This spec adds a SEPARATE column `users.staff_notification_preferences` and SEPARATE endpoints for staff prefs; the existing admin column and admin endpoints are untouched.

**`users.communication_preferences`** is the top-level kill switch: `{ sms_enabled, email_enabled, marketing_enabled }`. NOT NULL JSONB. The critical-path-override logic in section 6.13 must respect this (a staffer who turns off SMS globally cannot have it forced back on by a critical-path category).

**`users.calendar_token`** EXISTS as `UUID UNIQUE DEFAULT gen_random_uuid()` for every user (`server/db/schema.sql:269`). The route `GET /api/calendar/feed/:token` ALREADY exists at `server/routes/calendar.js:287` (~477 lines of working code with rate limiting, ETag / Last-Modified, staff vs admin projection). Token rotation route is `POST /api/calendar/token/regenerate` at `server/routes/calendar.js:463`. This spec extends that feed, it does NOT create a parallel one.

**`users.onboarding_status`** CHECK enum at `server/db/schema.sql:25` is `IN ('in_progress','applied','interviewing','hired','rejected','submitted','reviewed','approved','deactivated')`. **`'suspended'` is NOT present today.** This spec adds it via the schema additions in section 7.

**`scheduled_messages.channel`** CHECK at `server/db/schema.sql:2307` is `IN ('email','sms')`. **`'push'` is NOT present today.** This spec widens it. Note: the table also has `entity_type` CHECK `IN ('proposal','shift','client','consult')` and `recipient_type` CHECK `IN ('client','staff','admin')`; there is NO `category` column. Cover-broadcast rows use `entity_type='shift'` with a new `message_type` value; staff push rows use `recipient_type='staff'`.

**`pay_periods.status`** CHECK at `server/db/schema.sql:2532` is `IN ('open','processing','paid')`. The drop endpoint's processing-period guard reads this value.

**`payouts`** records carry inline snapshots: `payment_method TEXT` + `payment_handle TEXT` per row. A paid stub is self-contained, changing a staffer's preferred handle later does not retroactively change paid payouts. This is the rationale for NOT introducing a separate payment-methods table.

### 5.6 Existing comms infrastructure

`scheduled_messages` dispatcher with `checkSuppression` (cascades on `proposals.status='archived'` etc.), `registerHandler(messageType, handlerFn, options)` at `server/utils/scheduledMessageDispatcher.js:47` (note: `options.category` is the CAN-SPAM classifier `'operational' | 'marketing'`, NOT a granular topic, the new 8-topic staff routing layers ON TOP via the new `notificationChannelResolver`, not via `registerHandler`'s `category` field), the `urgent_staffing` admin-notification category (already wired to email + SMS), `sendAndLogSms`, `notifyAdminCategory`. Phase 4a staff SMS handlers (shift_reminder, staff_thank_you, shift_unassignment_notice, etc.) already exist. The new Cover-Needed broadcasts ride this infrastructure.

**Patterns the cc-import + Touch 2.2 merges exposed that this spec follows:**

- `checkSuppression` is exported from `server/utils/scheduledMessageDispatcher.js` (line 683). The staff portal's dispatcher integration reuses it for the `communication_preferences` kill-switch re-check rather than duplicating the SELECT.
- `SKIP_REANCHOR_TYPES` (a `Set` in `server/utils/rescheduleProposal.js`) lists `message_type` values that bypass re-anchoring on reschedule. If any new staff-portal message_type (e.g., `cover_broadcast`, `beo_unack_nudge_sms`) should NOT re-anchor when the event date moves, add it to that set in the same change.
- No `category` column exists on `scheduled_messages`. Category-aware routing lives in handler registration (`registerHandler({ category })`) and in the new `pickChannelsForUserAndCategory` helper, NOT as a per-row column. Section 6.13 reflects this.

## 6. Architecture

### 6.1 New shell + routes

**`client/src/components/StaffShell.js`** replaces `StaffLayout.js`. Topbar with the brand mark + name on the left, user-pill on the right. Tab nav below with the 4 tabs. Active tab persists per-tab even when an overlay (ShiftDetail / PayoutDetail / AccountPage) is open. Children area renders the active tab body.

**`client/src/components/StaffUserPillMenu.js`** is the dropdown menu opened by the user-pill button. Modal-style with a scrim. Contents:

- Top header card: 32px avatar + full name + email
- "Lighting" segmented control: House lights (sun icon) / After hours (moon icon). Changes immediately, persists to `users.ui_preferences.theme` via a `PATCH /api/me/ui-preferences` call. Click anywhere outside the segmented control to close.
- Menu items: Edit profile, Calendar sync, Notification preferences, Get support, Sign out (red).
- Each item dispatches the corresponding route: profile / payments / calendar / notif / docs sub-section, or `mailto:staff@drbartender.com`, or the sign-out action.

**URL space.** `App.js` exposes two staff-portal route blocks: `HiringRoutes()` (line 248, mounted when `context==='hiring'`) and `StaffSiteRoutes()` (line 298, mounted when `context==='staff'`). Both wrap their staff routes in `<RequirePortal><StaffLayout/></RequirePortal>` at lines 273 and 316. This spec updates BOTH wrappers to `<RequirePortal><StaffShell/></RequirePortal>` so the new portal renders on both subdomain contexts (the hiring subdomain hosts staff routes for new hires immediately post-onboarding). The new mount table:

| URL | Component | Tab active |
|---|---|---|
| `/` | HomePage | Home |
| `/shifts` | ShiftsPage (Available default) | Shifts |
| `/shifts/mine` | ShiftsPage (Mine sub-tab) | Shifts |
| `/shifts/past` | ShiftsPage (Past sub-tab) | Shifts |
| `/shifts/:shiftId` | ShiftDetail | Shifts (stays active) |
| `/pay` | PayPage | Pay |
| `/pay/:periodId` | PayoutDetail (with optional `?shift={shiftId}` query for the highlight cross-link) | Pay (stays active) |
| `/tip-card` | TipCardPage | Tip Card |
| `/account/profile` | AccountPage (Profile sub-section) | Account (overlay) |
| `/account/payments` | AccountPage (Payments) | Account (overlay) |
| `/account/calendar` | AccountPage (Calendar) | Account (overlay) |
| `/account/notifications` | AccountPage (Notifications) | Account (overlay) |
| `/account/documents` | AccountPage (Documents) | Account (overlay) |
| `/verify-email/:token` | EmailVerifyPage | (no tab; unauthenticated route, NOT inside `<RequirePortal>`) |

**Redirects from old URLs** (in `client/vercel.json` or via `<Navigate>` in `App.js`): `/dashboard` → `/`, `/events` → `/shifts/mine`, `/schedule` → `/shifts/mine`, `/profile` → `/account/profile`, `/resources` → `/account/documents`, `/my-tip-page` → `/tip-card`. **Keep `/my-tip-page/print` mounted** (renders the existing `<PrintTipCard/>`); the print route is shared with the public tip page and physical-card production, and a redirect would break those flows. Before merging, grep `client/src/App.js` for any other staff-portal sub-routes (e.g., legacy deep links not in this table) and add redirects for them in the same change. 30-day grace period of redirects; remove after.

### 6.1.5 UI state coverage (applies to every new page in §6.2-6.14)

Every new page and sub-section in this spec MUST implement the four async states. Listed once here so the per-page sections below can stay terse:

- **Loading**: skeleton placeholders matching the rendered layout (not a blocking spinner). Initial mount uses skeleton cards; subsequent refetches use a subtle progress bar at the top of the section.
- **Empty**: explicit copy for the zero-result case. New hires arrive with no shifts, no requests, no payouts, no tips, no documents. Each section that can be empty has spec-defined empty-state copy (called out per-section below where it deviates from the default). Default copy pattern: *"No [thing] yet. [What changes that.]"*.
- **Error**: when an API call fails (network error or 5xx), render a small inline error card with the section's name + Retry button. The error card does NOT replace the page chrome (tabs, header, user-pill); only the failed section. The button reissues the same request.
- **Disabled / pending**: every button that fires a mutation flips to disabled-with-spinner while the request is in flight. Buttons re-enable on response (success or error). Double-tap protection is the disabled flip, not a debounce.

Form fields enforce client-side validation rules that mirror the server-side rules called out per-endpoint in §6.10 / §6.11 / §6.13 / §6.14. Invalid input shows an inline error message under the field; the Save button stays disabled until all rules pass. The server-side validation is the authoritative gate; the client-side mirror exists for UX feedback only.

### 6.2 HomePage

Layout (top to bottom):

- **Hero**: greeting based on time of day + today's full date.
- **"Needs you" tray** (conditional, rendered only if any of the three entry types have items):
  - Unconfirmed BEOs for upcoming shifts: "Confirm the [client] BEO" (alert icon, amber)
  - Pending shift requests waiting on admin: "Request pending, [client]" (clock icon, neutral)
  - Cover-needed broadcasts by teammates: "Cover needed: [first + last-initial], [stripped event label]" with sub-line that adapts based on `you_are_on_team` (info-colored people icon)
- **Next shift card**: the soonest upcoming approved shift, rendered as a ShiftCard with `showConfirmFlag` on. Empty state if no upcoming shifts.
- **This pay period** tile: projected payout + payday + event count, tapping opens PayoutDetail for the current period.
- **Open shifts teaser**: top 2 open shifts with a "All (N) →" link to Shifts/Available.

Data sources: `GET /api/me/staff-home` returns a single composite payload of all four sections. Backend composes: next shift from `GET /shifts/user/:userId/events`, pending requests from `shift_requests WHERE user_id=$1 AND status='pending'`, cover broadcasts from `shift_requests WHERE cover_requested_at IS NOT NULL` plus a join to determine `you_are_on_team`, current pay period from the existing `payouts` table. Aggregated for the page load; clients re-fetch on tab-focus.

### 6.3 ShiftsPage

Top hero "Shifts" + sub-line. Sub-tab seg control: Available (count) / Mine (count of upcoming + pending) / Past (count). The sub-tab is reflected in the URL (`/shifts/available`, `/shifts/mine`, `/shifts/past`).

**Available** sub-tab. List of open shifts in chronological order. Each shift card shows: date / time, relative day, client name, event type, location, time range, positions needed (chips), pay estimate (chip), already-requested count (if any), conflict warning (if it overlaps an approved shift the user already has). When `cover_requested_at IS NOT NULL`, the card gets:

- Subtle accent border (`cover-needed` modifier class)
- Inline banner inside the card body: *"[first + last-initial] needs a cover, grab the slot."*
- "Cover needed" warn chip in the card foot
- Request button copy flips from "Request" to "Cover this"

Sort stays chronological regardless of cover status. Cover-needed badge is the visual signal; sort is not promoted.

Submitting a request on a cover-needed shift posts to `POST /api/shifts/requests/:shiftId/claim-cover` (new endpoint) rather than the generic request. Both flows create `shift_requests` rows but the claim-cover path also ties the new request to the original cover request for management's one-click swap approval.

**Mine** sub-tab. Pending requests (status `pending`) first, then upcoming approved shifts in chronological order. Pending rows are slightly faded (`opacity: 0.85`) with a "Withdraw" button. Approved rows use the same ShiftCard as Home, with `showConfirmFlag`. The Withdraw button calls `DELETE /api/shifts/requests/:requestId` (new endpoint, in `server/routes/shifts.js`): verifies ownership, requires `status='pending'` (you can only withdraw a pending request; an approved shift drops via the §6.5 flow), DELETEs the row. Withdrawal does NOT need to touch `shifts.status` because the staffer was never approved. Returns 200 on success, 409 with `reason='already_approved'` if the status changed under the user's feet.

**Past** sub-tab. Completed shifts in reverse-chronological order. Each card opens PayoutDetail at the matching shift line (`/pay/:periodId?shift=:shiftId`) NOT ShiftDetail. Status chip is Paid (green) or Processing (info-blue) per the linked pay period's status. Card foot shows the line-total `$` earned for that shift in mono.

Data sources: shifts via the existing `/api/shifts` endpoint with the BEO spec's projection updates (LEFT JOIN drink_plans for `finalized_at` + the requester's `beo_acknowledged_at`). Open shifts in the staff path; mine via `/api/shifts/user/:userId/events`; past via the same with a completed filter. Adding `payout_id` projection per past shift_request (or computing via a join to payout_events) so the Past list can construct the right `/pay/:periodId` URL.

### 6.4 ShiftDetail page

The BEO viewer (no longer a separate route). Backed by `GET /api/beo/:proposalId` (the BEO spec's endpoint).

Layout (top to bottom):

- **Back** button to Shifts/Mine (or wherever the user came from)
- **Title**: client name. Sub-line: event type + package.
- **Quick-status chips**: BEO confirmed (green) or BEO awaiting confirm (warn); position chip; "Shift approved" chip if applicable.
- **Key info grid**: Date (with relative day), Service time, Be there by (computed via `setupTimeDisplay(proposal, pkg)`), Guests, Location, Dress code, Load-in.
- **Action row**: Get directions, Add to calendar, Call client (3 small buttons).
- **"Banquet Event Order" section heading.**
- **Team roster card** ("On the team"). Renders only when `team_roster.length > 0`. Each row:
  - Avatar with initials
  - Display name = first + last initial (e.g., "Rosa M.")
  - Role label below the name when applicable (Bartender / Server / Barback); no Lead badge
  - "Needs cover" indicator if the teammate has an active cover request
  - "You" inline pill on the viewer's own row (no role label or contact actions on self row)
  - Two icon buttons on the right (call / text) that deep-link via `tel:` and `sms:`
- **Drinks card** (Signature cocktails, Mocktails, Custom requests, rendered per the BEO spec section 7.3)
- **Addons card**
- **Logistics card** (only if logistics data present)
- **Custom menu card** (only when `selections.menuStyle` is `custom` or `house`)
- **Notes from the lead / From the client cards** (per BEO spec sections 7.7)
- **Consult input card** (per BEO spec section 7.7.1)
- **Shopping list link** (per BEO spec section 7.8)
- **Drop / Cover card** (see 6.5)
- **Sticky Confirm action bar** at the bottom (per BEO spec section 7.9).

### 6.5 Drop / Cover flow

A single Drop / Cover card on ShiftDetail (just above the Confirm action bar). Mode and copy are computed from time-to-event in **hours**, not days:

| Hours to event start | Mode | Card title | Card sub | Button copy | Button tone |
|---|---|---|---|---|---|
| >= 336 (>= 14 days) | drop | "Drop this shift" | "14+ days out, simple swap. Slot goes back to the open pool." | "Drop shift" | neutral |
| 72 to under 336 | cover | "Need a cover" | "Under 14 days. Cover broadcasts to qualified bartenders; you stay on the roster until someone picks it up." | "Need a cover" | warn |
| under 72 | emergency | "Emergency, can't make it" | "Under 72 hours. Late-drops bypass cover broadcast and ping management by SMS." | "Emergency, can't make it" | danger |

Tap → modal:

- **Drop mode**: simple confirm sheet. Calendar icon, "Drop this shift?" title, body explains the slot returns to the open pool and management is notified. Two buttons: Never mind / Yes, drop the shift.
- **Cover mode**: users icon (warn), title "Broadcast a cover request," body explains responsibility stays until covered. Optional textarea: *"Reason (optional). Helps the next bartender understand the gig."* Buttons: Never mind / Broadcast cover request.
- **Emergency mode**: alert icon (danger), title "Emergency, can't make it," body explains management gets pinged by SMS immediately and repeated late-drops affect future bookings. Required textarea: *"What happened? (required)"* with a min-length gate (10 chars; button disabled below threshold). Buttons: Cancel / Notify management now (danger).

Post-submit, the Drop / Cover card on ShiftDetail flips to a green result chip: "Shift dropped. Management notified." / "Cover request broadcast." / "Management notified by SMS." The chip stays until the page is left.

**Endpoints** (new, in `server/routes/shifts.js`). All four are `auth`-gated. The three `/:requestId/*` endpoints additionally enforce `req.user.id === shift_requests.user_id` (own-request ownership). The `/:shiftId/claim-cover` endpoint enforces a state check, not ownership (see below).

**Common pre-check: pay-period status guard.** All four endpoints SELECT the shift's pay period via `payout_events.shift_id → payouts.pay_period_id → pay_periods.status`. If the pay period is `'processing'` (mid-payout), the drop/cover mutation is rejected 409 with `reason='pay_period_processing'`. Reason: a drop or cover flip can re-compose `payout_events` rows that are currently being settled. **NULL-payout case:** a future shift has no `payout_events` row yet (events accrue at payout time, not on shift creation). The LEFT JOIN returns NULL, the guard treats this as "no processing period to protect" and the mutation proceeds. Emergency drop bypasses this guard entirely by design (management resolves manually).

**Hours-to-event computation.** `hoursToEvent = (event_datetime - NOW()) / 3600000` where `event_datetime` is composed from `shifts.event_date + shifts.start_time`. Times in `shifts` are stored as `VARCHAR(50)` in the venue's local timezone (per CLAUDE.md, no global timezone normalization). This spec adds a NEW helper at `server/utils/shiftTime.js` (listed in §8.1) that exports `parseShiftDateTime({ event_date, start_time }) => Date` and treats the input as America/Chicago wall-clock. The closest existing helper is `buildEventTimes` at `server/routes/calendar.js:70`, but it returns ICS-formatted strings, not a comparable JS Date, the new helper is a small dedicated parser the four drop/cover endpoints share. Boundary semantics follow the inequalities literally: `hoursToEvent >= 336` is clean drop, `72 <= hoursToEvent < 336` is cover broadcast, `hoursToEvent < 72` is emergency. Exactly 72.0 falls into cover broadcast (the table is authoritative; ignore the prose's "higher-numbered mode" phrasing in earlier drafts).

**`POST /api/shifts/requests/:requestId/drop`**, clean drop, 14+ days out. Inside one transaction (`BEGIN`):
1. SELECT request + linked shift + proposal (`FOR UPDATE` on the shift_requests row).
2. Verify `req.user.id === shift_requests.user_id`. Verify pay-period not `'processing'`. Verify hours-to-event >= 336.
3. UPDATE `shift_requests SET status='denied', dropped_at=NOW(), drop_reason='clean_drop'`.
4. UPDATE the linked `shifts.status='open'` if no other approved staffer remains.
5. Suppress all pending `scheduled_messages` rows targeting this user for this shift, NOT just `cover_broadcast`: `UPDATE scheduled_messages SET status='suppressed' WHERE entity_type='shift' AND entity_id=$shift_id AND recipient_id=$user_id AND status='pending'`. This covers BEO unack nudges, shift reminders, and any other Phase 4a staff handler rows that would otherwise fire to a dropped user.
6. Call `notifyAdminCategory({ category: 'urgent_staffing', subject, emailHtml, emailText, ...(daysOut <= 7 ? { smsBody } : {}) })`.
7. COMMIT. Return 200.

If hours-to-event < 336, return 409 with `reason='wrong_mode'` (defensive; UI should not show the Drop button below that threshold).

**`POST /api/shifts/requests/:requestId/request-cover`**, cover broadcast, 72h to under 14d. **Transaction A** (fast, holds row lock):
1. SELECT request + shift (`FOR UPDATE`). Verify ownership, pay-period not `'processing'`, hours-to-event in `[72, 336)`.
2. UPDATE `shift_requests SET cover_requested_at=NOW(), cover_reason=$reason` (reason capped at 500 chars server-side; longer payloads return 413). Staffer remains `status='approved'`.
3. Resolve qualified-teammate list (see below). Capture the list to memory.
4. Notify management (urgent_staffing, email always, SMS if `daysOut <= 7`).
5. COMMIT.

**Then, outside any transaction** (no row lock held, no pool connection retained):

6. Insert `scheduled_messages` rows in batches of 25 with a 250 ms `setTimeout` between batches (application-level, not `pg_sleep`). Each row is `message_type='cover_broadcast'`, `entity_type='shift'`, `entity_id=shift.id`, `recipient_type='staff'`, `recipient_id=teammate.id`, with the channel resolved by `pickChannelsForUserAndCategory(teammate.id, 'cover_needed')`. Insertion is idempotent via `INSERT ... ON CONFLICT DO NOTHING` keyed on the partial unique index `idx_scheduled_messages_cover_broadcast_dedupe` (per §7). If the application crashes mid-batch, the next request-cover retry resumes cleanly because the existing rows are deduped on the unique index.

7. Return 200 with `broadcast_count` describing the number of rows ENQUEUED in step 6. Note: this is enqueue count, NOT projected delivery count. The dispatcher's per-row send-time check against `communication_preferences` may still suppress individual rows.

**Qualified-teammate filter.** The shift's `positions_needed` is a `TEXT DEFAULT '[]'` column (per `server/db/schema.sql:280`) holding JSON-encoded data with HETEROGENEOUS shapes across the codebase: some writes produce `[{ position: 'bartender', count: 1 }]` objects (per `client/src/components/adminos/shifts.js`), others produce plain string arrays. The targeting code MUST tolerate both via the existing pattern `typeof p === 'string' ? p : p.position` (used by `server/utils/autoAssign.js:137` and `client/src/pages/staff/StaffShifts.js:103`). The candidate match is `EXISTS (SELECT 1 FROM jsonb_array_elements(positions_needed::jsonb) AS p WHERE COALESCE(p->>'position', p#>>'{}') = contractor_profiles.position)`. The new `position` column is added in §7 and backfilled from `applications.positions_interested` (JSON-decoded first element, lowercased; default `'bartender'` for legacy rows). The teammate must additionally:
- Be on `users.onboarding_status='approved'` (NOT 'suspended' / 'deactivated' / 'rejected').
- NOT be the requesting user.
- Have `cover_needed` channels non-empty in `staff_notification_preferences.channels.cover_needed` (any of `'push' | 'sms' | 'email'`; the default ships with `["push"]`).
- NOT already have an `approved` shift_request on the same `event_date` (avoid double-booking the prospective replacement).

**Twilio rate-limit + runaway guard.** Two layers:
- Per-broadcast pacing: 25 rows per insert batch with 250 ms application-level delays between batches (NOT `pg_sleep` inside any transaction). A 500-teammate broadcast spreads over 5 seconds without holding any row lock.
- Per-shift cap: hard limit of 500 rows enqueued per `shift_id` for `message_type='cover_broadcast'`. If the qualified-teammate list exceeds 500 after filtering, the broadcast TRUNCATES to the first 500 (sorted by user_id ASC for determinism) and the response includes `broadcast_truncated: true`. Admin email also flags the truncation so management can manually re-broadcast if needed.
- Dispatcher-level: the existing exponential-backoff on Twilio 429 responses handles the actual send-side rate limit.

**`POST /api/shifts/requests/:shiftId/claim-cover`**, a teammate claims an active cover request. Inside one transaction:
1. SELECT the original cover-requesting `shift_requests` row (`FOR UPDATE`), the row where `shift_id=:shiftId AND cover_requested_at IS NOT NULL AND status='approved' AND dropped_at IS NULL`. If no such row exists, return 409 with `reason='no_active_cover_request'`. Adding `dropped_at IS NULL` prevents claiming a cover on an emergency-dropped row whose `cover_requested_at` was stale. Adding `FOR UPDATE` here is the concurrency guard: two simultaneous claims serialize on this row lock, so the loser sees the same SELECT after the winner's INSERT and proceeds against a still-active state (or sees the swap completed via the cascade and the row's `cover_requested_at=NULL`, then rejects 409 `reason='already_covered'`).
2. Verify shift state: `shifts.status` is NOT `'cancelled'`. Pay period is not `'processing'` (per common pre-check).
3. Verify the claiming user is NOT the same user who requested the cover (`req.user.id !== original.user_id`).
4. Verify the claiming user is qualified for the shift's role (`contractor_profiles.position` matches one of `shifts.positions_needed`, same filter as the broadcast targeting). A barback cannot claim a bartender slot.
5. Check whether the claiming user has a PRIOR `shift_requests` row on this shift (denied from an earlier request the staffer withdrew, etc.). `shift_requests` carries `UNIQUE(shift_id, user_id)` at `schema.sql:304`, so a fresh INSERT would conflict.
6. UPSERT: `INSERT INTO shift_requests (shift_id, user_id, status, replaced_by_request_id) VALUES (...) ON CONFLICT (shift_id, user_id) DO UPDATE SET status='pending', replaced_by_request_id=EXCLUDED.replaced_by_request_id, dropped_at=NULL, drop_reason=NULL, cover_requested_at=NULL`, if a prior denied row exists, flip it back to pending; if none exists, INSERT new. The new pending row points BACK to the original cover-requester via `replaced_by_request_id`; on admin approval the cascade reads this column to find which row to flip. Reject 409 if the existing row is already `status='approved'` (the user already covered this shift; nothing to do).
7. Send a signed, expiring approve-link email to management. URL: `/admin/shifts/cover-swaps/:swapToken` where `swapToken` is a JWT signed with `JWT_SECRET`, payload `{ original_request_id, new_request_id, exp: NOW + 7 days, jti: <uuid> }`. Two new admin routes back this:
   - `GET /api/admin/cover-swaps/:swapToken` (listed in §8.1): `auth` middleware + admin role check + JWT verification. The auth guard is critical because URL tokens leak via Referer headers, browser history, and admin email forwarding; without it, anyone holding a stale link in their history could replay it. Renders a small confirm page.
   - `POST /api/admin/cover-swaps/:swapToken` (listed in §8.1): same auth + JWT verification. Triggers the cover-approval cascade.

   The cascade's idempotency check (the original's `cover_requested_at=NULL` after the first approval) protects against JWT replay within the 7-day window; an admin clicking the link a second time sees a "Cover already resolved" page. If the JWT has expired, the page renders an "expired link, find the swap in the admin Shifts dashboard" message; no automatic re-issue.
8. COMMIT. Return 200.

If the email send fails after COMMIT, the cover-claim pending row remains in place; admin can still approve via the normal Shifts dashboard. The send-failure is logged to Sentry but does not roll back the claim.

**Cover-approval cascade** (runs inside the existing `PUT /api/shifts/requests/:requestId` approval branch when the new request has `replaced_by_request_id` set). Wrapped in a single transaction:
1. Approve the new request: `UPDATE shift_requests SET status='approved' WHERE id=$new`.
2. Flip the original to denied + mark covered: `UPDATE shift_requests SET status='denied', dropped_at=NOW(), drop_reason='covered_by_request:<new_id>', cover_requested_at=NULL WHERE id=$original`.
3. Suppress the remaining `cover_broadcast` rows for this shift: `UPDATE scheduled_messages SET status='suppressed' WHERE entity_id=$shift_id AND message_type='cover_broadcast' AND status='pending'`.
4. Fire the existing `scheduleStaffShiftMessages` for the new staffer (BEO nudge, shift reminder, etc.).
5. If the proposal's drink_plan is `finalized`, insert the BEO acknowledge-nudge for the new staffer.
6. COMMIT. Return 200.

A mid-cascade failure rolls back the whole transaction; the original staffer remains the active one and the broadcast rows stay pending so a different teammate can still claim.

**`POST /api/shifts/requests/:requestId/emergency-drop`**, under 72h. Body: `{ reason: string (10..500 chars) }`. The textarea in the UI carries a one-line warning under the field: *"Don't include sensitive medical or personal details. Admins can see this and it's retained in our records."* Inside one transaction:
1. SELECT context (`FOR UPDATE`). Verify ownership, hours-to-event < 72. Pay-period processing-status guard does NOT apply (management resolves manually; an emergency drop is not blocked by an in-flight payout).
2. UPDATE the request with `dropped_at=NOW(), drop_reason=reason (truncated to 500), drop_emergency=true`. Leave `status='approved'` (the staffer remains nominally on the roster).
3. **Hybrid-state rule:** every downstream consumer that reads `shift_requests.status='approved'` MUST also check `dropped_at IS NULL` to determine whether the staffer is actually working. This rule applies to: `scheduleStaffShiftMessages` (no new SMS to the dropped staffer), `autoAssign` (treat the seat as vacant), `shift_reminder` dispatcher (skip), `payout_events` accrual (the drop_emergency case requires manual management resolution before any wage accrues). The §11 testing matrix verifies each of these.
4. Suppress all pending `scheduled_messages` rows targeting this user for this shift (same SQL as the clean-drop step 5): `UPDATE scheduled_messages SET status='suppressed' WHERE entity_type='shift' AND entity_id=$shift_id AND recipient_id=$user_id AND status='pending'`.
5. Notify management urgently. Email always via `notifyAdminCategory('urgent_staffing', ...)`, which resolves admin recipients from admin users' `contractor_profiles.phone` for SMS and admin users' `users.email` for email (NOT from the `ADMIN_PHONE` env var). Additionally, IF `ADMIN_PHONE` env var is set, send a one-shot SMS to that number too via `sendAndLogSms({ to: process.env.ADMIN_PHONE, body })`, the env var is a separate emergency hotline (Dallas's personal phone) per CLAUDE.md, distinct from the admin-user-phone fan-out. If `ADMIN_PHONE` is unset, log a structured warning *"Emergency-drop hotline SMS skipped: ADMIN_PHONE not configured"* via `Sentry.captureMessage` (NOT a breadcrumb, breadcrumbs need a transaction context) so ops can spot the configuration gap. SMS body slices the reason at 80 chars with the front-loaded template: `"EMERGENCY DROP from ${name}: ${reason_first_80}"`.
6. INSERT into `proposal_activity_log` with `proposal_id=shift.proposal_id` (derived from the SELECT in step 1), `action='emergency_drop_requested'`, `actor_type='staff'`, `actor_id=req.user.id`, `details={reason, hours_out, shift_id, request_id}`. If `shift.proposal_id IS NULL` (orphan shift), skip the insert with a Sentry warning; orphan shifts are an admin-side data-integrity bug, not a staff-portal concern.
7. COMMIT. Return 200.

### 6.6 PayPage

Top hero "My Pay" + sub-line. Current pay period banner (large total + payday + status chip Processing / Paid). Line items for the current period (each event is a `PayoutEventRow` that expands to show wage / gratuity / card-tip / adjustment breakdown). Year-to-date roll-up card. Paystubs list of paid periods.

Tapping a line in the current period or paid history opens **PayoutDetail** for that pay period.

Data: existing staff-payments endpoints (`GET /api/me/payouts` returning the list, `GET /api/me/payouts/:periodId` returning the detail). No new endpoints.

### 6.7 PayoutDetail page

A single pay period with all line items. Accepts an optional `?shift=:shiftId` query param: when present, scroll to and highlight the matching event card (`sp-highlight` class on the card).

Layout: back button to Pay; title (Paystub or Period preview); period range + event count; banner with total + status chip; Summary card (wages / gratuity / card tips gross / card processing fee / adjustments / payout total); per-event detail cards (one per `payout_events` row), each card showing wage breakdown, gratuity share, card-tip gross + fee, adjustments; pay actions (Download PDF if paid, Email a copy); a small italic 1099 reminder at the bottom.

### 6.8 TipCardPage

Top hero "Tip Card" + sub-line. The QR card preview (existing FakeQR-style render of the print card). Row of action buttons: Open print page, Share link, Copy URL.

"Tips received this week" card listing recent tips, fed by the existing `GET /api/me/tips` endpoint (`server/routes/me.js:190`).

**"How it's shown on your card"** reorder card:

- Sub-line: *"Drag (or use the arrows) to reorder. Top of the list shows first on the printed card and on the /tip/{slug} chooser page."*
- One row per tip-eligible method on file (always-on card payments, plus Venmo / Cash App / PayPal / Zelle if added). Each row: drag grip + method icon + label + handle text (mono) + up/down arrow buttons (for accessibility, keyboard / screen-reader users).
- "Manage methods →" link in the card head opens AccountPage / Payments.

Reorder persists immediately on drag-end or arrow-tap to `users.ui_preferences.tip_card_order` (a JSON array of method-id strings).

**Public tip-page consumer extension** (load-bearing for money flow). The existing public `/tip/:token` page is served by `server/routes/publicTip.js` and renders the chooser the guest sees after scanning the QR. That route MUST be extended in the same change:

1. JOIN `users u ON u.id = payment_profiles.user_id` so the route can project `u.ui_preferences->'tip_card_order'` into the response.
2. Include the new `zelle_handle` in the chooser projection alongside Venmo / Cash App / PayPal.
3. Order the chooser methods by the projected `tip_card_order` array; methods present on the staffer's profile but absent from the order array fall to the end in their natural order. Methods in the order array but absent from the staffer's profile are skipped.
4. Set `Cache-Control: private, no-cache` on the response (or `max-age=60` if a small cache window is acceptable). The route is public-by-token so any proxy/CDN cache can serve stale order to guests for minutes after a staffer reorders. CLAUDE.md doesn't pin the policy; pick `private, no-cache` for v1 since the QR-scan path is the money flow.

Without this consumer update, a staffer's drag-reorder + Zelle handle would silently NOT appear on the QR-scan path, guests would see a stale order from the old route logic. §11 testing must verify the public `/tip/:token` response matches the staffer's TipCardPage rendering within seconds.

**No "Tips route to" pill** on this page. Preferred-for-tips does not exist as a concept (the QR opens a chooser).

### 6.9 AccountPage shell

A single overlay component with a horizontal sub-nav (Profile / Payment methods / Calendar sync / Notifications / Documents). Each sub-section is its own React component swapped in. Header is the user's avatar + name + role + email. Footer is the Sign-out button + the help-email line.

### 6.10 AccountPage / Profile

Personal info card with:

- Preferred name + Legal name (legal is read-only, lock icon, helper text linking to staff@drbartender.com)
- Email + Phone (with mono font and SMS sub-helper)
- Mailing address (full width, "For 1099 forms in January" sub-helper)
- Emergency contact sub-section: Name + Phone + Relationship in one row

Save button in the card header. On save, posts to `PATCH /api/me/profile`. Server-side validation: phone format (E.164 via existing util), email format, ZIP (5 or 5+4 digits), emergency contact fields each <= 100 chars. The PATCH writes to `contractor_profiles` columns directly.

**Email change is a separate flow, not a synchronous PATCH.** A compromised account that can flip `users.email` instantly bypasses password-reset email verification.

Endpoints (all listed in §8.1):
- `POST /api/me/request-email-change`, auth-gated, scoped by `req.user.id`. Validates + creates the pending row + sends verification email.
- `POST /api/me/confirm-email-change`, **NOT auth-gated** (the user clicking the link from the new-email inbox may not be signed in, or may be signed in as a different account). Looks up the pending row by `token_hash` ONLY; the `user_id` to mutate comes from the pending row, NEVER from `req.user.id`. This is the load-bearing security property: a signed-in attacker cannot replay a victim's leaked token against their own account.
- `POST /api/me/cancel-pending-email-change`, auth-gated. Marks the requesting user's most recent pending row `consumed_at=NOW()`.

Flow:
1. Rate-limit guard on `POST /api/me/request-email-change`: 3 pending requests per user per 24h (via the existing `server/middleware/rateLimiters.js`). Prevents weaponized harassment via verification-email floods to a victim.
2. Client opens a confirmation modal: *"Change your email? We'll send a verification link to the new address. Your current login stays active until you click the link."*
3. Server-side validation: email format (existing regex). Reject 409 `reason='email_in_use'` if another `users` row has this email. The new UNIQUE INDEX in §7 on `pending_email_changes.LOWER(new_email) WHERE consumed_at IS NULL` enforces the "no two users have a pending change to the same email" rule atomically via `ON CONFLICT (LOWER(new_email)) DO NOTHING` then check rows-affected (race-safe). If THIS user already has a prior pending row, mark it `consumed_at=NOW()` (superseded) before inserting the new one (most-recent-wins).
4. Server generates a 32-byte random token via `crypto.randomBytes(32).toString('base64url')`. Stores `token_hash = sha256(token)` (64-hex-char) in `pending_email_changes` (schema in §7). The raw token is included only in the verification email URL; a DB leak does not grant verification rights.
5. Row shape: `(user_id, new_email, token_hash, expires_at = NOW() + INTERVAL '24 hours')`.
6. **Notify the OLD email address** at the same time, separate from the new-address verification. Subject: *"Email change requested on your Dr Bartender account"*. Body: *"Someone (probably you) just asked to change your account email to [new_email]. Your account stays on the current address until that change is confirmed via a link sent to the new address. If this wasn't you, sign in now and tap Cancel pending change in your Profile, or reach out to support@drbartender.com."* This is the takeover-recovery signal.
7. Verification email sent to the NEW address with a link to a CLIENT-side React route `https://staff.drbartender.com/verify-email/:token` (NEW unauthenticated route in App.js, does NOT live under `<RequirePortal>`; the user may click the link from a logged-out browser). The route renders a "Confirm email change" page with a single Confirm button. Clicking Confirm POSTs to `POST /api/me/confirm-email-change` with `{ token }` in the body. The GET landing page does NOT consume the token (so email clients' auto-prefetch can't accidentally confirm).
8. On confirm POST: server hashes the token with `crypto.timingSafeEqual` after row fetch (defense against any edge timing leaks on the indexed lookup). Finds the matching row where `consumed_at IS NULL AND expires_at > NOW()`. In one transaction:
   - SELECT the row + the current `users.email` for the affected user
   - UPDATE `users SET email = new_email`
   - UPDATE `pending_email_changes SET consumed_at = NOW()` for this row
   - INSERT `staff_audit_log (action='email_change_confirmed', details={old_email, new_email})`
   - **Bump `users.token_version`** (new column, added in §7) so every existing JWT for this user becomes invalid, the legitimate owner OR the attacker, whoever started the flow, is forced to sign in again with the new email. (Existing auth middleware reads `users.token_version` and rejects tokens with a stale version.)
   - Send a final notification email to the OLD address: *"Your account email has been changed to [new_email]. If this wasn't you, contact support immediately."*
9. Subsequent clicks on the same link see `consumed_at IS NOT NULL` and render a "Already used" page.
10. Expired rows are purged by a daily cleanup scheduler.

The Profile UI shows a "Pending verification, check [new email]" banner until the change confirms or expires. The banner copy includes a "Cancel pending change" affordance that posts to `POST /api/me/cancel-pending-email-change` (marks `consumed_at = NOW()`). After expiry, the banner disappears on the next page load (the next `/api/me` fetch returns no pending row).

The verification email body is a new template `emailChangeVerification` in `server/utils/lifecycleEmailTemplates.js`; the old-address warning email is `emailChangeWarning`. Both follow the existing template patterns. Resend rejection / hard bounce: the request still succeeds at the API layer (the pending row is created); the staffer can attempt re-send via the Cancel + re-request flow. Bounce reports surface via the existing Resend webhook handler at `server/routes/webhooks/resend.js`.

**Phone changes get an audit-log entry.** Phone is the SMS-leg recovery channel; a takeover that flips it bypasses recovery without trace. On `PATCH /api/me/profile` when `phone` is in the body and differs from the current value, INSERT a row into `staff_audit_log` (`user_id=req.user.id`, `actor_type='staff'`, `actor_id=req.user.id`, `action='profile_phone_change'`, `details={old_phone_last4, new_phone_last4}`). The full numbers are not logged in the audit row, only last 4. Email changes also INSERT a `staff_audit_log` row on PENDING (`action='email_change_requested'`, `details={new_email}`) AND on CONFIRM (`action='email_change_confirmed'`, `details={old_email, new_email}`).

### 6.11 AccountPage / Payment methods

Structure:

- **Top pill**: "Payroll routes to: [icon] [label] · [identifier]" with a [Change] button that scrolls down to the methods list.
- **"Methods on file"** sub-section listing every method:
  - Card payments always-on row (non-editable, non-removable, "Always on" chip)
  - Tip-eligible methods (Venmo / Cash App / PayPal / Zelle), editable handle, deletable, can be set as Preferred for payroll if the staffer wants P2P payroll
  - Payroll-only methods (Direct deposit / Check), editable (direct deposit shows masked account `Chase ••••4321`), deletable, can be set as Preferred for payroll
  - "Preferred for payroll" chip on the active payroll target
  - Per-row buttons: Set as preferred (only payroll-eligible), edit (pencil icon, inline edit), remove (X icon)
- **"Add a method"** button at the bottom opens a modal:
  - Two categories: Tip-eligible (Venmo, Cash App, PayPal, Zelle) and Payroll only (Direct deposit, Check)
  - Tap a category option → input form for that method (handle text for P2P, routing + account for direct deposit, no input for check)
  - Validate and add
- **Footer disclaimer** (italic small): *"Card payments settle through Dr. Bartender and appear as card_tip_net_cents on your paystub. It's your responsibility to enter handles correctly. Payments sent to typos are not our liability."*

**Data model.** No new table. The canonical staff-payment row is `payment_profiles` (one row per user). All handles, the W-9, the tip-page token, and the payroll-target indicator already live there. This spec adds one column (`zelle_handle TEXT`) and reuses the rest.

The seven payment methods the UI surfaces map onto `payment_profiles` columns as follows:

| UI method | Column read / written | Notes |
|---|---|---|
| Card | n/a (conceptual row, no DB representation) | Always-on, non-deletable, settled through the platform |
| Venmo | `venmo_handle TEXT` | Existing column |
| Cash App | `cashapp_handle TEXT` | Existing column |
| PayPal | `paypal_url TEXT` | Existing column (full URL, not just a handle) |
| Zelle | `zelle_handle TEXT` | **New column added in section 7** |
| Direct deposit | `routing_number VARCHAR(255)` + `account_number VARCHAR(255)` | Existing columns. **AES-256-GCM ciphertext** (already encrypted on the staff-payments side). New endpoints MUST decrypt on read and encrypt on write via `server/utils/encryption.js`. |
| Check | (no handle data; preferred-only) | Indicated by `preferred_payment_method='check'` only |

**Payroll target.** `payment_profiles.preferred_payment_method TEXT` already holds the active payroll route. Values: `'venmo' | 'cashapp' | 'paypal' | 'zelle' | 'direct_deposit' | 'check'`. The "Set as preferred" action on a row writes this column. There is no separate `is_preferred_payroll` flag (the column itself is the source of truth, and is single-valued by construction). When the user clears the handle for the currently-preferred method, the server auto-flips `preferred_payment_method` to `NULL` and surfaces a Profile warning chip on the next portal load.

**Tip card display order.** Persists on `users.ui_preferences.tip_card_order` as an array of method tokens, e.g. `['venmo', 'card', 'cashapp', 'paypal']`. The `'card'` token is always implicit, position determined by where the user placed it (default first if absent). Reorder writes the full array on each save.

**Payouts unaffected.** Past payouts already snapshot `payment_method` + `payment_handle` per row on `payouts`. Editing a handle today does not retroactively change a paid stub, which is why the canonical `payment_profiles` row (rather than a multi-row table) is sufficient.

**Endpoints** (all on `server/routes/me.js`, auth-gated, scoped by `req.user.id`):

- `GET /api/me/payment-methods`, projects all P2P handle columns from `payment_profiles` raw (Venmo / Cash App / PayPal / Zelle are plaintext). For direct deposit, projects `routing_number_last4` (computed as `last 4 chars of decrypt(routing_number)`) and `account_number_last4` (same pattern). **NEVER projects full `routing_number` or `account_number` to the client**, only last-4. Decryption goes through `server/utils/encryption.js`; if decrypt fails (corrupt ciphertext, missing key), the route returns the field as `null` with a Sentry-captured error rather than 500ing the whole GET. Also returns `preferred_payment_method` and the conceptual Card row metadata (server-rendered with a stable shape so the client doesn't need to know whether it's a real DB row). When the user has no `payment_profiles` row yet (new applicant pre-payment-setup), the route returns a synthetic empty shape with all handles `null` rather than 404, so the AccountPage renders as "no methods yet."
- `PATCH /api/me/payment-methods`, body is a partial map drawn from a STRICT allowlist: `{ venmo_handle?, cashapp_handle?, paypal_url?, zelle_handle?, routing_number?, account_number?, payment_username? }`. Any key outside this set causes the request to reject 400 with `{field: 'body', error: 'Unknown field: <name>'}` BEFORE any DB read, defense against payload smuggling like `{ user_id: 99, ... }`. The allowlist is a hardcoded const in the route handler, not derived from `Object.keys`. Writes only the allowlisted keys present; null clears. Validates P2P handles server-side via `server/utils/tipHandleValidation.js`. Validates Zelle handle as either E.164 phone or RFC-5322 email (Zelle accepts both); add a `zelle` branch to `tipHandleValidation` for this. For routing/account, validates ABA-checksum on routing and length on account (9-digit routing, 4-17 digit account) BEFORE encryption. **Encryption flow for routing/account** (load-bearing):

  1. SELECT the existing `payment_profiles` row (`FOR UPDATE`).
  2. If only `routing_number` is in the PATCH body, leave `account_number` ciphertext untouched (do NOT decrypt + re-encrypt the unchanged field, it adds nothing and risks corruption if the key cycles mid-request). Same for account-only PATCH. Validation on the unchanged side is skipped, the existing ciphertext is trusted as-stored.
  3. For each changed bank field, run `encrypt(plaintext)` via `server/utils/encryption.js` and write the resulting ciphertext to the column. If `encrypt()` raises (key missing, fail-closed in prod per CLAUDE.md), the route returns 500 with `{error: 'encryption_unavailable'}` and the transaction rolls back.
  4. COMMIT.

  **Decrypt failures on unchanged sides.** If a partial PATCH validates routing successfully but the EXISTING `account_number` ciphertext fails to decrypt during the preferred-method-eligibility check (next paragraph), the route does NOT auto-clear the corrupt field. It logs a Sentry error with `{user_id, column: 'account_number'}` and proceeds with the PATCH (only writes the changed field). Admin tooling is responsible for repairing corrupt ciphertext; the staff portal does not attempt rescue.

  If the PATCH clears a routing or account field (sets it to `null`), persist `null` directly (no encryption needed). If only routing is cleared but account remains, mark `preferred_payment_method='direct_deposit'` as invalid by auto-NULLing it (same auto-NULL behavior as P2P handle clears).

  **Audit log on every payment-method mutation.** After the PATCH commits, INSERT into `staff_audit_log` with `user_id=req.user.id`, `actor_type='staff'`, `actor_id=req.user.id`, `action='payment_method_change'`, `details={fields_changed: ['venmo_handle','routing_number',...], cleared: [...]}`. The audit trail records WHICH fields were touched but not the new values (handles are not PII-sensitive once added but the diff doesn't need to live in the audit; `payment_profiles` itself holds current state). Same audit applies to `PUT /api/me/preferred-payment-method` (`action='preferred_payment_method_change'`, `details={from, to}`).

- `PUT /api/me/preferred-payment-method`, body is `{ method: 'venmo' | 'cashapp' | 'paypal' | 'zelle' | 'direct_deposit' | 'check' }`. Validates that the corresponding handle column is populated (rejects 400 with `{field: 'venmo_handle', error: 'Add a Venmo handle before setting it as preferred.'}` if not). For direct_deposit, the check is "BOTH `routing_number` AND `account_number` are non-null." For check, no handle is required. Writes `payment_profiles.preferred_payment_method`.
- `PUT /api/me/tip-card-order`, body is `{ order: ['venmo', 'card', 'cashapp', 'paypal'] }`. Writes to `users.ui_preferences.tip_card_order`. Validates that every token in the order array is one of `{'card', 'venmo', 'cashapp', 'paypal', 'zelle'}`; rejects 400 otherwise. Client serializes drag-end → PUT (no parallel PUTs); if a second drag fires before the first PUT resolves, the second drag is queued and dispatched on response.

**Delete semantics.** Tip-eligible handle deletion = `PATCH /api/me/payment-methods` with the relevant field set to null. If the deleted handle was the preferred-payroll target, server clears `preferred_payment_method` to NULL in the same transaction. No DELETE endpoint required.

**No data migration needed.** All handle columns already exist on `payment_profiles`. The only schema change is the new `zelle_handle` column (idempotent ALTER). Existing tip-page flows continue to work because they read the same columns.

### 6.12 AccountPage / Calendar sync

**Reuses existing infrastructure.** `server/routes/calendar.js:287` already implements `GET /api/calendar/feed/:token` against `users.calendar_token UUID UNIQUE DEFAULT gen_random_uuid()` (assigned to every user). Rate limiting, ETag / Last-Modified, role-aware projection (staff see only their approved shifts; admins see everything), and token rotation (`POST /api/calendar/token/regenerate` at line 463; `GET /api/calendar/token` at line 447) all ship. This spec extends the existing feed, it does not create a parallel one.

Three subscribe buttons (deep links composed against the existing feed URL):

- Google Calendar: `https://calendar.google.com/calendar/r?cid=<encoded https feed url>`
- Apple Calendar: `webcal://<api-host>/api/calendar/feed/<token>` (webcal scheme triggers the OS calendar subscribe sheet)
- Outlook: Outlook's subscription URL with the feed pre-filled

Subscription URL block below the buttons: read-only URL (the existing `/api/calendar/feed/:token` URL) + a Copy button (toggles to a "Copied" checkmark for 1.8 seconds). A "Regenerate URL" affordance below the Copy button calls the existing `POST /api/calendar/token/regenerate` route, with a confirm dialog warning that previously-subscribed apps will stop syncing.

Footer note: *"Refreshes every 5 minutes. Includes your confirmed shifts, plus an all-day reminder 3 days before any unconfirmed BEO. Past shifts roll off after 30 days."*

"Last sync" sub-section: shows the last time the calendar app pulled the feed (server tracks `users.last_ics_fetch_at` per user) and which app subscribed (detected via User-Agent on each fetch, persisted to `users.ui_preferences.calendar_subscribed_app`). Empty states: when `last_ics_fetch_at IS NULL` (no subscription yet, most existing users will be here on Phase A merge), render *"Not yet synced. Tap a subscribe button above to start."* and hide the app-name + relative-time line. When `calendar_subscribed_app` is missing from the JSONB (subscription pulled before User-Agent detection landed, or unrecognized client), render *"Last synced [relative]. (App not detected)"*. A Disconnect button clears the tracked state (`last_ics_fetch_at = NULL`, `calendar_subscribed_app` key removed from JSONB) but does NOT rotate the token (use the explicit Regenerate URL action for that). The User-Agent string is trivially spoofable; surface a tooltip on the app-name chip: *"Detected from your calendar app. May be wrong if you use an uncommon client."*

**Feed extensions for the staff portal.** The existing `buildICalFeed` builder in `server/routes/calendar.js` (line 211) is extended to also emit:

- All-day VEVENTs 3 days before each unconfirmed-BEO shift: `DTSTART;VALUE=DATE = (shift_event_date - 3 days)`, `TRANSP:TRANSPARENT` (does not block the day visually), SUMMARY = `"Confirm BEO: <client>"`, DESCRIPTION includes a deep link to `https://staff.drbartender.com/shifts/<id>`. One all-day VEVENT per affected shift.
- The shift-level VEVENTs (already in the feed) gain the staff-portal deep link in their DESCRIPTION field for staff projections.

Source of "unconfirmed BEO": `drink_plans.finalized_at IS NOT NULL AND shift_requests.beo_acknowledged_at IS NULL` (the BEO spec's existing fields).

**Per-fetch side effects** (new work, NOT yet implemented in `calendar.js`. The `users.last_ics_fetch_at` column is also new, added by §7):

- `users.last_ics_fetch_at = NOW()` written on every successful `GET /api/calendar/feed/:token` response, **debounced** to once per 10 minutes (`UPDATE users SET last_ics_fetch_at = NOW() WHERE id = $1 AND (last_ics_fetch_at IS NULL OR last_ics_fetch_at < NOW() - INTERVAL '10 minutes')`). Without debounce, a staffer subscribed on iPhone + Mac + iPad would generate ~864 writes/day on the `users` row across all staff; the WHERE clause makes the update a no-op on hot fetches.
- `users.ui_preferences.calendar_subscribed_app` set per the User-Agent (Google fetches identify as `Google-Calendar-Importer` or fetch from `Calendar.google.com`; Apple from `iCal/macOS` or `iOS/`; Outlook from `Microsoft Office/Outlook`). Use `jsonb_set` to merge into the existing JSONB without clobbering other keys. Same 10-min debounce condition applies, the UA detection should only re-run when the timestamp also updates.

Cache header is already `Cache-Control: private, max-age=300` (5 min).

### 6.13 AccountPage / Notifications

8-row × 3-column matrix. Each cell is a toggle. Per-row label + sub-line copy.

| Topic | Label | Sub-line | Defaults |
|---|---|---|---|
| shift_offered | New shifts I qualify for | Open shifts that match my role. | SMS + Email + Push |
| shift_decided | Request approved or denied | Decision on a shift I requested. | SMS + Push |
| cover_needed | Cover needed | A teammate is looking for someone to cover their shift. | Push only |
| beo_finalized | BEO ready to confirm | A BEO is locked and waiting for my confirm. | SMS + Email + Push |
| beo_reminder_t3 | 3 days out reminder | Auto SMS if I haven't confirmed an upcoming BEO. | SMS + Push |
| schedule_change | Schedule changes | Date, time, or location changed on a confirmed shift. | SMS + Email + Push |
| payday | Payday | When a paystub posts and a payout is sent. | SMS + Email |
| tip_received | Tips received | Customer used my QR card. Push only by default. | Push only |

Push column behavior:

- Top of section, a banner reflecting the browser permission state: granted (green), denied (red with re-enable instructions), unsupported (banner says "Your browser doesn't support push"), iosNeedsInstall (amber banner: *"iOS: install Dr. Bartender on your home screen to receive push"* with a "Show me how" link → coachmark modal).
- iOS coachmark modal: 3-step list with icons (Share button → Add to Home Screen → Open from home screen → return here to toggle push), with a single "Got it" button to dismiss.
- Toggling a push cell on for the first time triggers `Notification.requestPermission()`. If denied, toggle stays off and banner state becomes "denied."

**Backend.** Add a NEW JSONB column `users.staff_notification_preferences` (separate from the existing admin-categories `users.notification_preferences`). Shape:

```json
{
  "channels": {
    "shift_offered":     ["push", "sms", "email"],
    "shift_decided":     ["push", "sms"],
    "cover_needed":      ["push"],
    "beo_finalized":     ["push", "sms", "email"],
    "beo_reminder_t3":   ["push", "sms"],
    "schedule_change":   ["push", "sms", "email"],
    "payday":            ["sms", "email"],
    "tip_received":      ["push"]
  },
  "push_subscriptions": [
    { "endpoint": "...", "keys": { "p256dh": "...", "auth": "..." }, "user_agent": "...", "subscribed_at": "..." }
  ],
  "quiet_hours": null
}
```

Why a new column rather than reusing the existing `users.notification_preferences`: that column is a NOT NULL JSONB pre-populated with 11 admin-side category booleans. Its PATCH route is `requireAdminOrManager`. Both the shape (flat key:boolean vs. nested channels[]) and the auth guard differ. Mixing staff prefs into it would either break the admin contract or require a polymorphic shape; a separate column is cleaner.

New endpoints (`server/routes/staffPortal.js`, auth-gated, no admin guard, scoped by `req.user.id`):

- `GET /api/me/staff-notifications`, returns the JSONB (initialized to a default if NULL). Browser-permission flags are computed client-side.
- `PATCH /api/me/staff-notifications`, partial update. Body merges into the existing JSONB. Use `jsonb_set` for atomic per-key updates so concurrent saves from multiple devices don't clobber.
- `POST /api/me/push-subscriptions`, body is a `PushSubscription` JSON from the browser plus the User-Agent. Appends to `staff_notification_preferences.push_subscriptions[]`. Returns 200.
- `DELETE /api/me/push-subscriptions`, body is `{ endpoint: '...' }`. Removes the matching subscription.

**Top-level kill switch.** `users.communication_preferences` is honored at TWO points: (1) the UI surface, the AccountPage / Notifications panel shows the current values and explains that they override all per-category toggles; (2) the server enforcement, every PATCH path that toggles a critical-path category off validates the combined state: if the proposed save would leave EACH of the three critical-path categories (`beo_finalized`, `schedule_change`, `payday`) individually with no deliverable channel, the server rejects 400 with `{field: '_form', error: 'Critical messages need at least one channel. Turn one on first.'}`. The check is per-category, not aggregate: a save that mutes only `payday` is fine if `beo_finalized` and `schedule_change` still have channels. Note: `communication_preferences.sms_enabled` is flipped today only via the STOP / START SMS keyword path at `server/utils/smsInbound.js` (there is no PATCH endpoint for staff to flip the kill switch directly); this spec does not add one. UI client mirrors this check for instant feedback but is not the only line of defense. Quiet hours, if non-null, suppress non-critical pushes during the window; critical-path pushes ignore quiet hours.

**Migration guard.** Existing users may already be in a bad state at the migration cutover: a prior STOP reply flipped `communication_preferences.sms_enabled=false`, AND their default `staff_notification_preferences.channels` includes SMS for critical categories. On their first unrelated PATCH after migration, the strict critical-path validation would 400 them with no path to fix it through the new UI. To prevent this:
1. Run a one-time migration UPDATE in §7: for users whose `sms_enabled=false` from a prior STOP keyword, strip `'sms'` from every category in their `staff_notification_preferences.channels` so the post-migration state is internally consistent (no SMS channel listed where SMS is globally killed).
2. The per-row override indicator in the AccountPage UI: when a category's SMS channel would be silently overridden by `communication_preferences.sms_enabled=false`, render a subtle strikethrough on the SMS toggle plus a tooltip *"Global SMS is off (you replied STOP). Reply START to your last Dr Bartender text to re-enable."*

**Critical-path override.** Three categories are critical: `beo_finalized`, `schedule_change`, `payday`. `pickChannelsForUserAndCategory(userId, category)` enforces: if ALL of a critical category's channels are toggled off in the user's prefs, fall back to a single deterministic channel (SMS for shift-related, email for payday). This fallback is itself gated by `communication_preferences`, if the user has turned off SMS globally, the critical-path override picks email instead. If BOTH SMS and email are globally off, the override returns the user's push subscription set IF any are present; if no push subscriptions exist either, the override returns `{ kind: 'dead_letter', reason: 'all_channels_blocked' }`. The dispatcher receiving a `dead_letter` resolution marks the row `status='dead_letter'` and fires `Sentry.captureMessage('critical_path_dead_letter', { user_id, category, message_type })` for ops visibility. The Sentry capture also fires every time a critical-path override degrades (e.g., push → SMS fallback) so ops can detect silent channel substitution before staffers complain. Footer copy: *"Critical-path messages. BEO finalized, schedule changes, payday, can't be fully muted. We'll deliver them through whatever channel is still on."*

**Dispatcher integration.** The cleanest pattern is **multi-row scheduling at enqueue time**, not `channel='auto'` resolution at dispatch time. Reasoning: `scheduled_messages.channel` has a CHECK constraint (`IN ('email','sms')` today, widened to `'push'` by section 7) AND `server/utils/messageScheduling.js:5` has a hardcoded `VALID_CHANNELS = new Set(['email','sms'])` validator that throws before any INSERT. An 'auto' value would break both. Instead:

- When a category-driven message is scheduled, the helper `enqueueCategorizedMessage(userId, category, payload)` resolves the channel set via `pickChannelsForUserAndCategory` at scheduling time and inserts ONE `scheduled_messages` row per resolved channel (e.g., a `beo_finalized` event for a staffer opted-in to push + SMS produces two rows: one with `channel='push'`, one with `channel='sms'`). The helper assigns each multi-row group a shared `suppression_key` derived from `${entity_type}:${entity_id}:${message_type}:${recipient_id}` so the cascade below can collapse siblings on first send.
- The dispatcher re-checks `communication_preferences` at send time and marks the row `status='suppressed'` (terminal) if the channel kill switch has flipped to false since enqueue. This prevents the row from being retried on every dispatcher tick.
- **Sibling-suppression cascade.** When any row in a `suppression_key` group sends successfully, the dispatcher updates the remaining pending rows in the same group to `status='suppressed_by_sibling'` (terminal) within the same transaction. This stops the user from getting the same notification on push AND SMS AND email when one channel is enough.
- For push specifically: each row's send call iterates the user's `push_subscriptions[]`. A 410 Gone or 404 response auto-prunes the dead subscription. To handle concurrent dispatches racing on `jsonb_set` of the same JSONB, the prune path runs inside a transaction with `SELECT ... FOR UPDATE` on the user row before the `UPDATE users SET staff_notification_preferences = jsonb_set(...)`.
- **Future-category backfill.** Adding a new category later (e.g., `'event_reminder_24h'`) will land in users' `staff_notification_preferences.channels` JSONB as a missing key. `pickChannelsForUserAndCategory` returns a documented default array per category (mirroring §6.13 defaults table) when the key is missing, rather than empty (which would silently suppress the message). The default-array lookup table lives in `notificationChannelResolver.js` as a `DEFAULT_CHANNELS` const and is the single source of truth for both the initial schema default AND the missing-key fallback.

Existing rows with `channel='sms'` or `'email'` continue to work unchanged; the new code path is additive.

**Push subscription dedupe + cap.** `POST /api/me/push-subscriptions` accepts `{ endpoint, keys, user_agent }`. Server-side, before INSERT, the route checks `staff_notification_preferences.push_subscriptions[]` for an existing entry with the same `endpoint`. If found, that entry is replaced in place (keys + user_agent + `subscribed_at` updated). This handles the same-browser-toggle-off-then-on case cleanly, and the rare case where the keys rotate without the endpoint changing.

The array is capped at 10 active subscriptions per user. When a new subscription would push the count above 10, the OLDEST entry (by `subscribed_at`) is evicted in the same `jsonb_set` operation (LRU prune). This prevents unbounded growth from a buggy client that re-subscribes on every page load.

**Re-resolve after sibling-cascade for critical-path categories.** When the dispatcher marks every row in a suppression_key group as terminal (`suppressed` / `suppressed_by_sibling` / `failed`) AND the category is in `CRITICAL_CATEGORIES`, the dispatcher re-runs `pickChannelsForUserAndCategory(user_id, category)` to get a fresh resolution against the CURRENT state of `communication_preferences` and `staff_notification_preferences`, then enqueues one new `scheduled_messages` row at that resolved channel with a fresh `suppression_key`. Each re-resolve increments a `re_resolve_count` on the row's `payload` JSON (added at enqueue time; default 0). When `re_resolve_count >= 2`, the dispatcher stops re-resolving and marks the row `dead_letter` + fires the Sentry capture, even if the resolver would still return live channels. This bounds the worst case (push subs all dead AND user toggles SMS off AND quiet hours active) at three send attempts total per critical message, not an infinite loop. Out-of-band alert: in addition to the Sentry capture, dead-letter resolution sends a one-shot SMS to `ADMIN_PHONE` (if set) with body `"DR BARTENDER: critical message dead-lettered for user ${user_id} category ${category}, check Sentry"` so ops sees it even if Sentry's noisy.

### 6.14 AccountPage / Documents

Two main sections + a small "Other archives" cross-link section.

**Reference** (org-wide):

- Field Guide row: links to `/field-guide` (existing route, a React page). No file metadata, no size, no updated date. Single "View" action button.

**My documents** (personal):

- W-9 row: file metadata + tags (signed) + Replace button.
- Independent Contractor Agreement row: file metadata + tags (signed). No Replace (signed legal doc).
- Alcohol certification row (renamed from BASSET certificate in the UI; backend column name `alcohol_certification_file_url` stays): file metadata + expires_on date + Replace button. Expiry treatment:
  - Within 60 days of `expires_on`: amber "Expires soon" tag in the title row, plus a nudge sub-line under the row: *"Heads up, your alcohol certification expires soon. Tap Replace to upload the renewed cert."*
  - Past `expires_on`: red "Expired" tag.

**Other archives** (cross-link):

- "Paystubs (N)" row that taps to `/pay`.

**Replace flow.** The modal varies by doc_type:
- **W-9**: file picker only. The W-9 has no expiry concept on staff_payment_profiles.
- **Alcohol certification**: file picker PLUS a required date input for the new `expires_on`. The date must be in the future (server-side validation: `expires_on > CURRENT_DATE`); the modal disables the Replace button until the date is set. The submit body includes `{ expires_on: 'YYYY-MM-DD' }` alongside the multipart file.
- **Independent Contractor Agreement**: no Replace (signed legal doc).

Common to both replaceable types:

1. Tap the Replace pencil icon on a replaceable row → opens the ReplaceConfirmModal.
2. Modal title: "Replace your [W-9 / alcohol certification]?"
3. Modal sub: "The new file becomes your active record. Choose a PDF or photo."
4. File picker (accept `.pdf,.png,.jpg,.jpeg`); after selection, the chosen file's name + size shows in the modal.
5. Buttons: Cancel / Replace (primary, disabled until a file is chosen).
6. On Replace, POST to `POST /api/me/documents/:doc_type/replace` (multipart). `doc_type` is `'w9'` or `'alcohol_certification'`. For `alcohol_certification`, the request body MUST include `expires_on` (date string, must be > CURRENT_DATE, reject 400 with `{field: 'expires_on', error: 'Expiry date must be in the future.'}` otherwise). The route honors the standard upload contract: `express-fileupload` parses the multipart, then `server/utils/fileValidation.js` (`isValidUpload(file)`) magic-byte validates the file (PDF / PNG / JPEG only), reject 400 if the magic bytes don't match the claimed MIME, regardless of the file extension. Cap at 10 MB; reject 413 above. **Filename sanitization**: the original filename is slugified to `[A-Za-z0-9._-]` only (strip slashes, traversal sequences, control chars) before interpolation into the R2 key, `fileValidation.js` validates magic bytes but NOT filename safety. Execution order is load-bearing:

   1. Validate the file (magic bytes + size). Fail before any side effect if the file is bad.
   2. Upload to R2 via `uploadFile(buffer, filename)` (per `server/utils/storage.js`, note: returns no URL, the file is keyed by `filename`; subsequent reads use `getSignedUrl(filename)` for 15-min-expiry access). Compute a deterministic R2 key like `staff/${doc_type}/${user_id}/${Date.now()}_${original_filename}` so re-uploads don't collide. If R2 upload fails, return 502 and nothing in the DB changes.
   3. Open transaction. SELECT the current `payment_profiles` row (W-9) or `contractor_profiles` row (alcohol cert) `FOR UPDATE` so a concurrent admin replace doesn't interleave.
   4. INSERT the previous URL + filename into `staff_document_history` (`replaced_by_user_id = req.user.id`).
   5. UPDATE the active record column(s) with the new R2 key:
      - `doc_type='w9'` → `payment_profiles.w9_file_url` + `payment_profiles.w9_filename` (NOT `contractor_profiles`)
      - `doc_type='alcohol_certification'` → `contractor_profiles.alcohol_certification_file_url` + `contractor_profiles.alcohol_certification_filename` + `contractor_profiles.alcohol_certification_expires_on = $expires_on`
   6. **Audit trail decision.** `staff_document_history` IS the audit trail; no separate audit-log table is needed for this surface. The history row carries `replaced_at`, `replaced_by_user_id`, the prior `previous_url`, and the prior `previous_filename`. Admin-side visibility (a "Previous versions" expander in `client/src/pages/admin/userDetail/tabs/DocumentsTab.js`) is a follow-up listed in §13, not in this scope.
   7. COMMIT. On any failure between step 3 and step 6, ROLLBACK leaves the active record unchanged. The orphan R2 object from step 2 is acceptable (storage cost is negligible; a cleanup sweep can collect orphans later, see §13 follow-up).

   The `staff_document_history` row schema:

```sql
CREATE TABLE IF NOT EXISTS staff_document_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type VARCHAR(50) NOT NULL CHECK (doc_type IN ('w9', 'alcohol_certification')),
  previous_url VARCHAR(500),
  previous_filename VARCHAR(255),
  replaced_at TIMESTAMPTZ DEFAULT NOW(),
  replaced_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_sdh_user ON staff_document_history(user_id);
```

7. The previous file's R2 key is NOT deleted (storage cost is negligible; preservation is the point).
8. Response: 200 with the new URL. The staffer's UI shows a small "Replaced" tag chip on the row.

Admin's existing `client/src/pages/admin/userDetail/tabs/DocumentsTab.js` can surface the history via a small "Previous versions" expander (out of scope for this spec; flag as a follow-up).

**No admin notification on replace** for either doc.

### 6.15 Existing surfaces to delete

Replaced wholesale. Delete in the same change:

- `client/src/pages/staff/StaffDashboard.js`, replaced by HomePage.
- `client/src/pages/staff/StaffEvents.js`, replaced by Shifts/Mine.
- `client/src/pages/staff/StaffShifts.js`, replaced by Shifts/Available.
- `client/src/pages/staff/StaffSchedule.js`, replaced by Shifts/Mine (chronological list, no calendar grid).
- `client/src/pages/staff/StaffProfile.js`, replaced by AccountPage / Profile.
- `client/src/pages/staff/StaffResources.js`. Quick Links go to AccountPage / Documents (Field Guide link) + AccountPage / Calendar sync; Support contact moves to user-pill menu "Get support" mailto.
- `client/src/pages/staff/MyTipPage.js`, replaced by TipCardPage + AccountPage / Payment methods.
- `client/src/components/StaffLayout.js`, replaced by StaffShell.

`PrintTipCard.jsx` + `PrintTipCard.layouts.jsx` + `PrintTipCard.css` are kept (the print flow stays; only the editor and the chrome change). `MyTipPage.css` is dropped if no longer imported anywhere.

### 6.16 Theme persistence

- `users.ui_preferences JSONB` with `{ theme: 'light' | 'dark' | null, tip_card_order: [...], calendar_subscribed_app: '...' }`.
- On first paint, the StaffShell reads `users.ui_preferences.theme`. If null, falls back to `window.matchMedia('(prefers-color-scheme: dark)').matches`. Sets `data-skin="light|dark"` on `document.documentElement`.
- When the user toggles the segmented control in the user-pill menu, the client posts to `PATCH /api/me/ui-preferences` with `{ theme: 'light' | 'dark' }` and updates `document.documentElement.dataset.skin` immediately. No optimistic-then-revert pattern needed for a single attribute flip.
- CSS uses skin-aware variables (`--ink-1`, `--surface-1`, `--accent`, etc.) that resolve from `[data-skin="light"] { ... }` / `[data-skin="dark"] { ... }` blocks at the root of `client/src/index.css`. The design's `staff/styles.css` is the source of these tokens.

### 6.17 Push notification infrastructure

**Service worker** at `client/public/staff-sw.js`. Registered in `client/src/pages/staff/index.js` (or the StaffShell mount). Handles `push` events and routes to a `notificationclick` listener that opens or focuses the staff portal at the relevant URL.

**VAPID keys** generated once (via `npx web-push generate-vapid-keys`) and stored as env vars `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Public key is injected into the client at build time as `REACT_APP_VAPID_PUBLIC_KEY`.

**Subscription flow:**

1. User toggles a push cell in Notification preferences.
2. Browser prompts for permission.
3. On grant, the client subscribes: `await navigator.serviceWorker.register('/staff-sw.js')` then `await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY })`.
4. The resulting `PushSubscription` JSON is POSTed to `/api/me/push-subscriptions`.
5. Backend appends to `users.staff_notification_preferences.push_subscriptions[]`.

**Sending:**

- New util `server/utils/pushSender.js` exports `sendPush({ subscription, title, body, url, tag, icon })`. Uses `web-push` npm.
- On dispatch, the dispatcher calls `pushSender.sendPush` per subscription. On 410 Gone or 404, removes the subscription from the user's prefs (see §6.13 dispatcher race handling for the FOR UPDATE pattern).
- Push notification payload includes a `tag` for grouping (one tag per category, so successive shift-reminder pushes replace the previous) and a `url` (the deep link to open on tap).
- **Fail-closed on missing VAPID keys.** If `VAPID_PRIVATE_KEY` is unset (dev environments, misconfigured prod), `sendPush` returns `{ ok: false, error: 'vapid_unset' }` immediately and fires a Sentry breadcrumb. The caller treats this the same as any other failure (mark row failed, do NOT crash the dispatcher loop). Matches the `stripeClient.js` fail-closed pattern.

**Service-worker click handler** opens or focuses the staff portal at the URL in the payload. Standard pattern.

**Service-worker cache-busting.** `staff-sw.js` is served from `/staff-sw.js` (root scope per Web Push requirements). Service workers cache aggressively, a deployed bug in the SW can persist for users until they manually clear or until the browser's update check runs (24h default). To cap user impact, the SW file embeds a `SW_VERSION` constant at the top (e.g., `'sw-2026-05-27-v1'`) that flips on every meaningful change; the SW's `install` handler skips waiting when the version differs from the cached version. Vercel's default `Cache-Control: no-cache` for the SW path is sufficient to let the browser see the new file on next page load.

### 6.18 Team roster on GET BEO

The BEO spec's `GET /api/beo/:proposalId` response includes a `shift_requests` array. Extend the projection to include the team roster as a derived field per the design's `team_roster[]` shape:

- For each `shift_requests` row where `status='approved' AND dropped_at IS NULL` (the hybrid-state filter from §6.5: emergency-dropped staffers stay `status='approved'` for management to resolve, but they are NOT on the active roster) on a non-cancelled shift linked to the proposal:
  - `user_id`
  - `display_name` (composed server-side). Resolution chain, first match wins:
    1. `contractor_profiles.preferred_name` if non-empty, paired with the last-initial from `applications.full_name` if available (e.g., `"Rosa M."`). If `applications.full_name` is NULL (legacy staffer without an application row, possible for the oldest hires), use `agreements.full_name` (LEFT JOIN `agreements ON agreements.user_id = users.id`). If both are NULL, render the preferred name alone (`"Rosa"`).
    2. If `preferred_name` is NULL, use first-token + last-initial of `applications.full_name`, else `agreements.full_name`.
    3. If all three are NULL, use the email-local-part (`users.email` before the `@`).
  - `initials` (computed server-side from the resolved display name; two characters; uppercased)
  - `is_me` boolean (true when `user_id === req.user.id`)
  - `role` from `shift_requests.position` (defaulting to `'Bartender'` when null)
  - `phone` from `contractor_profiles.phone` (E.164), **gated by the viewer's status**: only project the phone field when the requesting `req.user`'s OWN `shift_requests.status` on this proposal is `'approved'`. Pending requesters (who haven't been confirmed for the gig yet) get `phone: null` for their teammates. This prevents a curious applicant who got into a pending state from harvesting active staff phone numbers via the BEO endpoint.
  - `needs_cover` boolean (true when `shift_requests.cover_requested_at IS NOT NULL`)

Phone is teammate PII visible to anyone on the same approved gig, fine for coworkers (already exposed via `shift_reminder` SMS) but the BEO response surface widens slightly per the BEO spec section 7.1.

## 7. Schema additions

All idempotent and additive. No data loss. Every ALTER is `IF NOT EXISTS`-style; every constraint widening goes through `DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT` inside a `DO $$ EXCEPTION WHEN OTHERS THEN NULL` block, matching the existing patterns in `server/db/schema.sql`.

```sql
-- Theme + tip-card order + calendar subscribed-app tracking
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_preferences JSONB
  NOT NULL DEFAULT '{}'::jsonb;

-- Per-user last calendar-feed fetch timestamp (powers the Account / Calendar "Last sync" panel)
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ics_fetch_at TIMESTAMPTZ;

-- Token version for session-invalidation on email change (per §6.10).
-- Existing JWTs embed the token_version at sign time; auth middleware rejects any
-- token whose version is below the current value. Bumped on email-change confirm
-- so the legitimate owner OR the attacker (whoever started the flow) must sign in
-- again with the new email.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;

-- Staff-side per-category × per-channel notification routing + push subscriptions
-- (separate from the existing admin-only users.notification_preferences).
-- Default uses '{...}'::jsonb literal (not jsonb_build_object) to match the existing
-- pattern at schema.sql:2233/2248 and produce a deterministic JSON key order.
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_notification_preferences JSONB
  NOT NULL DEFAULT '{
    "channels": {
      "shift_offered":   ["push","sms","email"],
      "shift_decided":   ["push","sms"],
      "cover_needed":    ["push"],
      "beo_finalized":   ["push","sms","email"],
      "beo_reminder_t3": ["push","sms"],
      "schedule_change": ["push","sms","email"],
      "payday":          ["sms","email"],
      "tip_received":    ["push"]
    },
    "push_subscriptions": [],
    "quiet_hours": null
  }'::jsonb;

-- Widen onboarding_status enum to include 'suspended' (active staff who break the rules)
-- NOTE: widening the CHECK alone is INSUFFICIENT. server/middleware/auth.js:41-49 currently
-- denies only 'deactivated' and 'rejected'. The same change that widens this constraint
-- MUST add 'suspended' to the deny list in auth.js, or a suspended user keeps full portal
-- access. Treat as one logical change: schema + middleware, single commit.
DO $$ BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_onboarding_status_check;
  ALTER TABLE users ADD CONSTRAINT users_onboarding_status_check
    CHECK (onboarding_status IN (
      'in_progress','applied','interviewing','hired','rejected',
      'submitted','reviewed','approved','suspended','deactivated'
    ));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- Widen scheduled_messages.channel enum to include 'push'
-- Companion change: server/utils/messageScheduling.js:5 has a hardcoded
-- VALID_CHANNELS = new Set(['email', 'sms']) that throws BEFORE any INSERT.
-- Add 'push' to that Set in the same commit, or push enqueue fails at the helper.
DO $$ BEGIN
  ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_channel_check;
  ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_channel_check
    CHECK (channel IN ('email','sms','push'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- Widen scheduled_messages.status enum for the §6.13 dispatcher cascade.
-- New terminal values:
--   'suppressed_by_sibling' = another channel in the same suppression_key group sent first
--   'dead_letter'           = critical-path override could not resolve any deliverable channel
-- Without this widening, the cascade's first UPDATE crashes on the existing CHECK.
DO $$ BEGIN
  ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_status_check;
  ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_status_check
    CHECK (status IN ('pending','sent','failed','suppressed','deferred','suppressed_by_sibling','dead_letter'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- Suppression-key column for the §6.13 sibling-suppression cascade.
-- Set by enqueueCategorizedMessage to a stable derived value:
--   ${entity_type}:${entity_id}:${message_type}:${recipient_id}
-- When one row in the group succeeds, the dispatcher updates the remaining pending
-- rows in the same group to status='suppressed_by_sibling' in one UPDATE.
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS suppression_key TEXT;
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_suppression_key
  ON scheduled_messages (suppression_key)
  WHERE suppression_key IS NOT NULL AND status = 'pending';

-- Cover-broadcast dedupe (per §6.5 runaway cap). Scoped to message_type='cover_broadcast'
-- to avoid collision with the existing idx_scheduled_messages_pending_uniq (schema.sql:2331)
-- which already enforces uniqueness on the same column tuple for status='pending'.
-- Combined with the application-layer cap of 500 rows per shift_id, this prevents
-- duplicate enqueues on retry without blocking legitimate re-enqueues of other types.
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_messages_cover_broadcast_dedupe
  ON scheduled_messages (entity_type, entity_id, recipient_type, recipient_id, channel)
  WHERE message_type = 'cover_broadcast' AND status IN ('pending','sent');

-- Drop / cover marketplace columns on shift_requests
ALTER TABLE shift_requests
  ADD COLUMN IF NOT EXISTS cover_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cover_reason TEXT,
  ADD COLUMN IF NOT EXISTS dropped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS drop_reason TEXT,
  ADD COLUMN IF NOT EXISTS drop_emergency BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS replaced_by_request_id INTEGER REFERENCES shift_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_shift_requests_cover_requested
  ON shift_requests(cover_requested_at) WHERE cover_requested_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shift_requests_dropped
  ON shift_requests(dropped_at) WHERE dropped_at IS NOT NULL;

-- Partial index for the hybrid-state filter that payrollAccrual / autoAssign / team-roster
-- queries all use after the emergency-drop rule lands ("approved AND not dropped").
CREATE INDEX IF NOT EXISTS idx_shift_requests_active_approved
  ON shift_requests(shift_id) WHERE status = 'approved' AND dropped_at IS NULL;

-- One new handle column on payment_profiles (Zelle); all other handle columns and the W-9 columns
-- already exist on payment_profiles (verified against server/db/schema.sql:129+ and :2000+).
ALTER TABLE payment_profiles ADD COLUMN IF NOT EXISTS zelle_handle TEXT;

-- Alcohol certification expiry tracking (for the 60-day expires-soon nudge)
ALTER TABLE contractor_profiles
  ADD COLUMN IF NOT EXISTS alcohol_certification_expires_on DATE;

-- Role attestation column for cover-broadcast targeting (per §6.5).
-- Populated at signup from applications.positions_interested[0] (the primary role).
-- Backfill UPDATE below seeds existing rows from their application; rows with no
-- application fall back to 'bartender' as the safe default.
ALTER TABLE contractor_profiles
  ADD COLUMN IF NOT EXISTS position TEXT;

-- applications.positions_interested is a JSON-encoded string (e.g. '["bartender","barback"]')
-- written by client/src/pages/Application.js:179 via JSON.stringify(selectedPositions).
-- Backfill JSON-decodes and takes the FIRST element, lowercased + trimmed. Legacy staff
-- with no application row get 'bartender' as the safe default. Wrapped in defensive
-- jsonb cast: if a row is malformed (legacy seed in comma-separated text format), the
-- nested CASE falls through to the SPLIT_PART path for migration safety.
UPDATE contractor_profiles cp
   SET position = COALESCE(
     LOWER(TRIM((
       SELECT CASE
         WHEN a.positions_interested ~ '^\[' THEN (a.positions_interested::jsonb->>0)
         ELSE SPLIT_PART(a.positions_interested, ',', 1)
       END
       FROM applications a WHERE a.user_id = cp.user_id
     ))),
     'bartender'
   )
 WHERE cp.position IS NULL;

CREATE INDEX IF NOT EXISTS idx_contractor_profiles_position
  ON contractor_profiles(position) WHERE position IS NOT NULL;

-- §6.13 migration guard: users who replied STOP previously have sms_enabled=false on
-- communication_preferences, but the new staff_notification_preferences default
-- still lists 'sms' for several categories. The first PATCH after migration would
-- trip the critical-path validation. Strip 'sms' from every channels array for
-- those users so the post-migration state is internally consistent.
UPDATE users u
   SET staff_notification_preferences = jsonb_set(
     staff_notification_preferences,
     '{channels}',
     (
       SELECT jsonb_object_agg(
         cat_key,
         COALESCE(
           (SELECT jsonb_agg(ch) FROM jsonb_array_elements_text(cat_val) AS ch WHERE ch <> 'sms'),
           '[]'::jsonb
         )
       )
       FROM jsonb_each(staff_notification_preferences->'channels') AS chans(cat_key, cat_val)
     ),
     false
   )
 WHERE (communication_preferences->>'sms_enabled')::boolean = false;

-- Pending-email-change verification flow (per §6.10). Patterns after the existing
-- password_reset_tokens table (schema.sql:1204). The token is a UUID stored hashed
-- (SHA-256) so a DB leak doesn't grant verification rights; the unhashed token only
-- exists in the outgoing verification email and the user's clipboard.
CREATE TABLE IF NOT EXISTS pending_email_changes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  new_email VARCHAR(255) NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  consumed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_email_changes_token_hash
  ON pending_email_changes(token_hash) WHERE consumed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_email_changes_new_email_pending
  ON pending_email_changes(LOWER(new_email)) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pending_email_changes_user
  ON pending_email_changes(user_id) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pending_email_changes_expires
  ON pending_email_changes(expires_at) WHERE consumed_at IS NULL;

-- Document replace history (snapshot of the previous file before a Replace overwrites the active record)
CREATE TABLE IF NOT EXISTS staff_document_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type VARCHAR(50) NOT NULL CHECK (doc_type IN ('w9', 'alcohol_certification')),
  previous_url VARCHAR(500),
  previous_filename VARCHAR(255),
  replaced_at TIMESTAMPTZ DEFAULT NOW(),
  replaced_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_sdh_user ON staff_document_history(user_id);

-- User-scoped audit log for staff portal mutations (phone change, email change,
-- payment-method change, preferred-method flip). `proposal_activity_log` is
-- proposal-scoped (FK to proposals) and doesn't fit user-only events; rather than
-- abuse a NULL proposal_id, this table mirrors that schema for user-scoped events.
CREATE TABLE IF NOT EXISTS staff_audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_type VARCHAR(20) NOT NULL DEFAULT 'staff' CHECK (actor_type IN ('staff','admin','system')),
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_audit_log_user ON staff_audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_audit_log_action ON staff_audit_log(action, created_at DESC);
```

**No data migration.** All payment handle columns and the W-9 columns already exist on `payment_profiles`; this spec only adds `zelle_handle`. The new `staff_notification_preferences` JSONB has a default value via the ALTER statement above, so backfill happens at column-creation time, not via a follow-up `UPDATE`. The existing `users.notifications_opt_in` BOOLEAN (if present) is preserved for backwards compatibility but not read by the new staff portal; admin tooling that references it is unaffected.

**Tables NOT introduced** (and why):

- ~~`staff_payment_methods`~~: redundant with the existing `payment_profiles` columns. `payouts.payment_method` + `payouts.payment_handle` already snapshot at payout time, so paid stubs are self-contained and a multi-row history is unnecessary.
- ~~Any new ICS route table~~: the existing `users.calendar_token` + `GET /api/calendar/feed/:token` route handle this.

## 8. Files

### 8.1 Server (new)

- `server/routes/staffPortal.js`, composite endpoints used by Home and other pages: `GET /api/me/staff-home`, `GET /api/me/payment-methods`, `PATCH /api/me/payment-methods`, `PUT /api/me/preferred-payment-method`, `PUT /api/me/tip-card-order`, `PATCH /api/me/profile`, `PATCH /api/me/ui-preferences`, `GET /api/me/staff-notifications`, `PATCH /api/me/staff-notifications`, `POST /api/me/push-subscriptions`, `DELETE /api/me/push-subscriptions`, `POST /api/me/documents/:doc_type/replace`, `POST /api/me/request-email-change`, `POST /api/me/cancel-pending-email-change`. All `auth`-gated, no `requireAdminOrManager`, scoped by `req.user.id`. The drop / cover endpoints (`POST /api/shifts/requests/:id/drop`, `/request-cover`, `/claim-cover`, `/emergency-drop`, plus the new `DELETE /api/shifts/requests/:requestId` for the §6.3 Withdraw flow) live in `server/routes/shifts.js`. `POST /api/me/confirm-email-change` (NOT auth-gated; looks up `user_id` from `pending_email_changes` via `token_hash` only, see §6.10) lives on its own minimal `server/routes/emailChange.js` so the unauthenticated handler isn't tucked under the auth-gated router.
- `server/routes/emailChange.js`, NEW. `POST /api/me/confirm-email-change`, unauthenticated, body `{ token }`, hashes the token + finds the pending row + executes the multi-step transaction described in §6.10 step 8. Mounted in `server/index.js` before any auth middleware.
- `server/routes/adminCoverSwaps.js`, NEW. `GET /api/admin/cover-swaps/:swapToken` + `POST /api/admin/cover-swaps/:swapToken`. Both `auth` + admin role check + JWT verification (per §6.5). The GET renders the confirm page payload; the POST triggers the cover-approval cascade.
- `server/utils/shiftTime.js`, NEW. Exports `parseShiftDateTime({ event_date, start_time }) => Date` (treats input as America/Chicago wall-clock) and `hoursToEvent(shift) => number`. Replaces the fabricated `parseShiftDateTime` reference from prior drafts. Co-located with `calendar.js`'s `buildEventTimes` helper but separate (different return shape).
- `server/utils/pushSender.js`, wraps `web-push` npm. Exports `sendPush({ subscription, title, body, url, tag, icon })`. Returns `{ ok: true }` on success or `{ ok: false, gone: true }` for 410 / 404 (caller prunes the subscription).
- `server/utils/notificationChannelResolver.js`, `pickChannelsForUserAndCategory(userId, category) => Promise<string[]>`. Reads `users.staff_notification_preferences` AND `users.communication_preferences` and returns the effective channel set (after kill-switch suppression + critical-path override). Pure helper, no I/O beyond the one user-row read. Includes a `DEFAULT_CHANNELS` const matching the §6.13 defaults table; future categories added later inherit defaults without backfill.
- `server/utils/staffCalendarFeedExt.js`, the VEVENT-list extension that the existing `server/routes/calendar.js` builder calls into to produce the BEO-confirm all-day reminders.
- `server/routes/staffPortal.test.js`, endpoint contract tests.
- `server/routes/emailChange.test.js`, `server/routes/adminCoverSwaps.test.js`, contract + auth tests for the new routes.
- `server/utils/pushSender.test.js`, `server/utils/notificationChannelResolver.test.js`, `server/utils/staffCalendarFeedExt.test.js`, `server/utils/shiftTime.test.js`.
- `server/utils/pushSender.js`, wraps `web-push` npm. Exports `sendPush({ subscription, title, body, url, tag, icon })`. Returns `{ ok: true }` on success or `{ ok: false, gone: true }` for 410 / 404 (caller prunes the subscription).
- `server/utils/notificationChannelResolver.js`, `pickChannelsForUserAndCategory(userId, category) => Promise<string[]>`. Reads `users.staff_notification_preferences` AND `users.communication_preferences` and returns the effective channel set (after kill-switch suppression + critical-path override). Pure helper, no I/O beyond the one user-row read.
- `server/utils/staffCalendarFeedExt.js`, the VEVENT-list extension that the existing `server/routes/calendar.js` builder calls into to produce the BEO-confirm all-day reminders. Co-located with the existing builder rather than a parallel file.
- `server/routes/staffPortal.test.js`, endpoint contract tests.
- `server/utils/pushSender.test.js`, `server/utils/notificationChannelResolver.test.js`, `server/utils/staffCalendarFeedExt.test.js`.

### 8.2 Server (modify)

- `server/db/schema.sql`, all schema additions in section 7.
- `server/routes/shifts.js`, new drop / cover endpoints (`POST /requests/:id/drop`, `/request-cover`, `/claim-cover`, `/emergency-drop`, `DELETE /requests/:id` for the Withdraw flow). The existing `PUT /api/shifts/requests/:requestId` approval branch is extended to detect `replaced_by_request_id IS NOT NULL` and run the cover-approval cascade described in §6.5. The existing routes also gain projection updates for the new pages: `GET /shifts` (staff path) adds `drink_plan_finalized_at`, `my_beo_acknowledged_at`, `cover_requested_at`, `cover_for_first_initial`; `GET /shifts/user/:userId/events` adds `payout_id` per past row (computed via a join to `payout_events`).
- `server/utils/payrollAccrual.js` (existing), extend the `WHERE sr.status = 'approved'` filter at line 115 to `WHERE sr.status = 'approved' AND sr.dropped_at IS NULL`. Without this update, emergency-dropped staffers accrue pay automatically when `accruePayoutsForProposal` fires on event completion. Required companion to §6.5's hybrid-state rule.
- `server/utils/autoAssign.js` (existing), extend the approved-seat count at line 142 to filter `dropped_at IS NULL` so emergency-dropped seats are correctly counted as vacant for re-fill. Same hybrid-state-rule companion.
- `server/middleware/auth.js`, extend the existing deny-list around line 41-49 to include `'suspended'` alongside `'deactivated'` and `'rejected'`. Required companion to the `users_onboarding_status_check` widening in §7. Same file also reads the new `users.token_version` column: when verifying a JWT, compare `decoded.token_version === user.token_version`; reject if mismatch (forces re-auth after email change per §6.10).
- `server/utils/jwt.js` (or wherever token-signing happens), embed `users.token_version` into the JWT payload on every sign. Existing tokens (signed before this change) lack the field, treat missing as version 1 for backwards compat.
- `server/routes/calendar.js`, extend `buildICalFeed` (the existing builder at line 211 powering `GET /api/calendar/feed/:token`) to call into `staffCalendarFeedExt` for the all-day "Confirm BEO" VEVENTs on unconfirmed-BEO shifts. Same change adds the backward 30-day cutoff on past shifts and the per-fetch `last_ics_fetch_at` UPDATE (debounced; see §6.12). No new route, no parallel builder.
- `server/utils/scheduledMessageDispatcher.js`, three changes: (1) before dispatching any row, re-check `users.communication_preferences` and skip rows whose channel kill switch has been turned off since enqueue; (2) for `channel='push'` rows, iterate `users.staff_notification_preferences.push_subscriptions[]` and call `pushSender.sendPush`; prune subscriptions that return `gone:true`; (3) the existing per-category suppression cascade extends to cover the multi-row push+sms+email enqueue pattern (one logical event = one suppression key).
- `server/utils/messageScheduling.js` (the existing scheduler-side helper, 66 lines), add `enqueueCategorizedMessage(userId, category, payload)` that resolves channels via `notificationChannelResolver` and inserts one `scheduled_messages` row per resolved channel. Also widen the hardcoded `VALID_CHANNELS = new Set(['email', 'sms'])` at line 5 to include `'push'`, otherwise the existing `scheduleMessage` validator throws before any push INSERT lands.
- `server/index.js`, mount `/api/me/*` (the staffPortal router) under the existing app instance. The existing `/api/calendar/*` mount stays.
- `server/utils/staffShiftHandlers.js`, cover-broadcast scheduling helper: when a `request-cover` endpoint fires, schedule cover-broadcast `scheduled_messages` rows per opted-in qualified teammate via `enqueueCategorizedMessage(teammateId, 'cover_needed', ...)`. The Twilio rate-limit guard from the BEO spec applies (chunked sends, exponential backoff on 429).
- `server/utils/smsTemplates.js`, new `cover_broadcast_sms` template + `staff_drop_to_management_sms` for the management-side urgent notifications on emergency drops.
- `server/utils/lifecycleEmailTemplates.js`, new templates: `emailChangeVerification` (sent to NEW email, contains the verification link) + `emailChangeWarning` (sent to OLD email on request) + `emailChangeConfirmed` (sent to OLD email after confirm).
- `server/utils/tipHandleValidation.js`, add a `validateZelleHandle(input)` function that returns `{ valid: true }` if the input matches either E.164 phone (`^\+?[1-9]\d{1,14}$`) or RFC-5322 email (use the existing email regex from the same file), else `{ valid: false, error: 'Zelle requires a phone number or email address.' }`. Wire into the existing `normalizeTipHandlesInPlace` switch.
- `server/routes/me.js` (existing), `GET /api/me` extended to include `staff_notification_preferences`, `ui_preferences`, and a flattened payment-methods snapshot, so the StaffShell can render without multiple GETs. **Push subscriptions are NOT projected** in the global `/api/me` payload (they bloat the response and aren't needed for page render); the AccountPage / Notifications section makes a separate `GET /api/me/staff-notifications` for the full prefs blob. The existing `GET /api/me/tip-page` route stays unchanged (now consumed by both TipCardPage and the AccountPage / Payment methods Card-row metadata).
- `server/routes/publicTip.js`, JOIN `users` to project `ui_preferences->'tip_card_order'`; add `zelle_handle` to the chooser projection; order the chooser methods by the staffer's saved order with fallback to natural order for methods not in the array. Without this, drag-reorder and the new Zelle column silently fail to surface on the QR-scan path (§6.8).
- `server/middleware/auth.js`, extend the existing deny-list around line 41-49 to include `'suspended'` alongside `'deactivated'` and `'rejected'`. Required companion to the `users_onboarding_status_check` widening in §7.

### 8.3 Client (new)

- `client/src/components/StaffShell.js`
- `client/src/components/StaffUserPillMenu.js`
- `client/src/pages/staff/HomePage.js`
- `client/src/pages/staff/ShiftsPage.js` (with Available / Mine / Past sub-components)
- `client/src/pages/staff/ShiftDetail.js` (the BEO viewer; absorbs the work that was Task 29 in the BEO plan)
- `client/src/pages/staff/PayPage.js`
- `client/src/pages/staff/PayoutDetail.js` (with `?shift=:shiftId` highlight)
- `client/src/pages/staff/TipCardPage.js` (with the drag-to-reorder card)
- `client/src/pages/staff/account/AccountPage.js` (shell + sub-nav)
- `client/src/pages/staff/account/ProfileSection.js`
- `client/src/pages/staff/account/PaymentMethodsSection.js`
- `client/src/pages/staff/account/AddMethodModal.js`
- `client/src/pages/staff/account/CalendarSyncSection.js`
- `client/src/pages/staff/account/NotificationsSection.js`
- `client/src/pages/staff/account/IOSCoachmark.js`
- `client/src/pages/staff/account/DocumentsSection.js`
- `client/src/pages/staff/account/ReplaceConfirmModal.js`
- `client/src/components/staff/DropCoverModal.js` (and its three mode variants)
- `client/src/components/staff/TeamRosterCard.js`
- `client/src/components/staff/ShiftCard.js` (the shared card used on Home, Shifts/Available, Shifts/Mine)
- `client/src/components/staff/PayoutEventRow.js`
- `client/src/utils/pushSubscribe.js` (browser-side helper for permission + subscription)
- `client/public/staff-sw.js` (service worker)
- Optional: `client/src/styles/staff-portal.css` namespaced styles ported from the design's `styles.css`, OR a styled-components / CSS-modules adoption, call this out as a choice the implementation plan resolves.

### 8.4 Client (modify)

- `client/src/App.js`, replace the staff route block in BOTH `HiringRoutes()` (around line 271) and `StaffSiteRoutes()` (around line 314): swap `<StaffLayout/>` for `<StaffShell/>` in each `<Route element>` wrapper, then replace the per-page route children with the new mount table from section 6.1. Old routes get `<Navigate to=... replace>` redirects for the 30-day grace period; the redirect list applies to both blocks.
- `client/vercel.json`, `staff.drbartender.com` subdomain rewrites stay; add the staff-sw.js path to the cache control (or rely on Vercel default).
- `client/src/index.css`, pull in the design's CSS tokens / skin-aware variables. The design's `styles.css` from `Dr Bartender (6)/staff/` is the source. Namespace under `[data-skin="light"]` / `[data-skin="dark"]` blocks.

### 8.5 Client (delete)

- `client/src/pages/staff/StaffDashboard.js`
- `client/src/pages/staff/StaffEvents.js`
- `client/src/pages/staff/StaffShifts.js`
- `client/src/pages/staff/StaffSchedule.js`
- `client/src/pages/staff/StaffProfile.js`
- `client/src/pages/staff/StaffResources.js`
- `client/src/pages/staff/MyTipPage.js` + `MyTipPage.css`
- `client/src/components/StaffLayout.js`

### 8.6 Docs

- `README.md`, folder tree updates (new staff portal files, removed fragments), Key Features (the new portal).
- `ARCHITECTURE.md`, route table (all the new `/api/me/*` rows plus the extended `/api/calendar/feed/:token`), schema section (new column + constraint widenings + the document-history table), notifications model section (channel-routing + critical-path override + push lifecycle).
- `CLIENT_FACING_SURFACES.md`, staff portal section overhaul.

## 9. Phasing

**Phase A. Portal shell + BEO embedding + drop/cover marketplace (SMS only).** Ship the new 4-tab portal with all the pages, the AccountPage (Profile / Payment methods / Calendar sync / Documents, minus push for notifications), the drop/cover flow with email + SMS to management. BEO content embeds inside ShiftDetail. Light/dark theme persists. Tip Card drag-reorder works. The Notifications page exists but the Push column is disabled across all rows (banner: "Coming in v1.5"). All existing SMS / email touches continue working via the existing dispatcher path with explicit channels.

**Phase B. Push notifications + channel routing.** Adds the service worker, VAPID setup, push subscriptions, `pushSender.js`, the channel-routing helper, and the dispatcher's auto-resolve logic. The Push column on Notifications activates. iOS coachmark goes live. Existing SMS / email touches stay unchanged unless the user opts in to push for that category.

Phase A is ~3-4 weeks of focused work. Phase B is ~1 week. Both ship as separate merges to main.

## 10. Authorization

- All `/api/me/*` endpoints are `auth`-gated and scope every read/write by `req.user.id`. IDOR guard is in the query (`WHERE user_id = $1`), not by trusting body params. The PATCH endpoints reject any payload key that maps to a user-scoped foreign key.
- The four drop / cover endpoints additionally verify `req.user.id === shift_requests.user_id` (you can only drop your own; admin uses different routes).
- The calendar feed `GET /api/calendar/feed/:token` is public-by-token (matching the existing `/tip/:token` pattern). Token is a UUID assigned to every user, can be rotated via `POST /api/calendar/token/regenerate`. Rate limiting is already enforced by the existing route.
- **`onboarding_status='suspended'` blocks portal access.** Adding the value to the CHECK constraint (§7) is paired with a `server/middleware/auth.js` deny-list update: the existing branch that denies `'deactivated'` and `'rejected'` extends to `'suspended'`. A suspended staffer's session token is still valid until expiry, but every `/api/me/*` request returns 401 (or 403 with a "suspended, contact management" payload, pick during implementation). Without this middleware change, the new CHECK value is cosmetic and the spec ships a security tripwire.
- Push subscription PII (`endpoint` URL, `keys`) is stored as JSON in `users.staff_notification_preferences.push_subscriptions[]`. This is the standard Web Push pattern, the keys are recipient-public (used by the server to encrypt the payload, but they don't grant access to anything beyond sending notifications to that endpoint). No encryption required.
- **Bank routing + account numbers** on `payment_profiles` are ALREADY stored as AES-256-GCM ciphertext in `VARCHAR(255)` columns (widened from VARCHAR(20)/VARCHAR(30) at schema line 1992 by the staff-payments work). The existing `server/utils/encryption.js` encrypts on write and decrypts on read; the module fails closed in production if `ENCRYPTION_KEY` is unset (verified at `server/utils/encryption.js:6` and `.env.example:16`). New staff-portal routes that read these columns (`GET /api/me/payment-methods` projecting last-4 of the account number) MUST call `decrypt()` before any slice or masking. The PATCH route MUST call `encrypt()` before persisting. Never log either column raw. Never project `account_number` past the last 4 digits on any client-facing endpoint.

## 11. Testing approach

**Server unit tests** (node:test, real dev DB per existing pattern):

- `staffPortal.test.js`:
  - `GET /api/me/staff-home` composes the four sections correctly
  - `GET /api/me/payment-methods` projects all handle columns from `payment_profiles` plus the conceptual Card row in the user's saved order
  - `PATCH /api/me/payment-methods` writes only present keys, validates handle formats via `tipHandleValidation`, rejects null routing-number on direct-deposit if account-number is non-null (and vice versa)
  - `PUT /api/me/preferred-payment-method` rejects 400 when the corresponding handle column is empty; writes `payment_profiles.preferred_payment_method` otherwise
  - `PATCH /api/me/payment-methods` that clears the currently-preferred handle auto-NULLs `preferred_payment_method` in the same transaction
  - `PUT /api/me/tip-card-order` validates order tokens against the allowed set; rejects unknown tokens
  - `PATCH /api/me/staff-notifications` partial update via `jsonb_set`
  - `POST /api/me/push-subscriptions` appends to the array; duplicate endpoints replace rather than duplicate
  - `POST /api/me/documents/:doc_type/replace` writes to `staff_document_history` BEFORE updating the active record (so the snapshot survives even if the active-record update fails)
  - All endpoints respect IDOR (a staffer cannot read or mutate another staffer's data)
- `shifts.test.js` additions:
  - `POST /requests/:id/drop` succeeds at 14+ days, returns 409 at 13d 23h, returns 409 when `pay_periods.status='processing'` for the period the shift falls into
  - `POST /requests/:id/request-cover` sets `cover_requested_at`, calls `enqueueCategorizedMessage` for opted-in qualified teammates; Twilio rate-limit guard chunks sends
  - `POST /requests/:shiftId/claim-cover` creates a new pending request linked via `replaced_by_request_id` and notifies management
  - `POST /requests/:id/emergency-drop` requires `reason` >= 10 chars, returns 400 below, succeeds at < 72h (computed in hours, not days)
  - `urgent_staffing` admin notification fires email always + SMS when hours_to_event <= 168 (7 days)
- `notificationChannelResolver.test.js`:
  - Returns the user's opted-in channels for a category, filtered by `communication_preferences`
  - `sms_enabled=false` removes SMS from every category's channel list
  - Critical-path override fires when all channels for `beo_finalized` / `schedule_change` / `payday` are off
  - Critical-path override degrades to push when both SMS and email are globally off
  - Returns empty for unsupported categories (defensive)
- `pushSender.test.js`:
  - Sends a push successfully (mocked web-push)
  - On 410 Gone, returns `gone:true`; caller prunes the subscription via `jsonb_set`
  - Handles invalid subscription gracefully
- `staffCalendarFeedExt.test.js`:
  - Emits all-day VEVENT for each unconfirmed-BEO shift 3 days before the event date
  - Skips already-confirmed BEOs (where `shift_requests.beo_acknowledged_at IS NOT NULL`)
  - Composes valid ICS lines (CRLF, proper escape of commas/semicolons in SUMMARY)
- `scheduledMessageDispatcher.test.js` additions:
  - Multi-row enqueue: a `beo_finalized` event for a staffer opted-in to push + SMS produces two `scheduled_messages` rows
  - `communication_preferences.sms_enabled=false` at send time suppresses an SMS row even though it was enqueued
  - Push row iterates `staff_notification_preferences.push_subscriptions[]`; 410 prunes the dead one
  - Critical-path override delivers SMS when the user has muted all channels for `beo_finalized`

**Client smoke tests** (existing `react-scripts` build with `CI=true` is the gate):

- `CI=true npm --prefix client run build` passes
- Manual: open the new staff portal as a staffer, walk each tab, confirm the BEO content renders inside ShiftDetail, drop a shift at >14d (clean drop), at 8d (cover broadcast), at 24h (emergency, requires reason)
- Manual: AccountPage / Notifications, toggle a push cell (granted state), confirm the browser permission prompt fires; on iOS Safari without installation, confirm the coachmark appears
- Manual: theme toggle persists across reloads and across devices (sign in on another browser, confirm the theme follows)
- Manual: Calendar sync, subscribe to Apple Calendar, confirm a confirmed shift appears in Calendar.app

**Manual verification matrix** (ship gate per phase):

Phase A:
1. Old URLs (`/dashboard`, `/events`, `/profile`, etc.) redirect to the new equivalents
2. Each of the 4 tabs renders end-to-end without console errors
3. ShiftDetail shows BEO content + team roster + drop/cover card
4. Drop a shift at 16d out → clean drop succeeds, shift returns to open pool, management email arrives
5. Cover a shift at 10d out → broadcast goes out (management email + each opted-in teammate SMS), original staffer stays approved
6. A teammate claims the cover → admin approves → swap completes
7. Emergency drop at 48h → modal requires reason, management email + SMS fires
8. Theme toggle persists across browser sessions
9. Tip Card drag-reorder persists, shows correctly on `/tip/:token` chooser page (existing public route reads `users.ui_preferences.tip_card_order`)
10. AccountPage / Payment methods: edit Venmo handle, set Venmo as preferred for payroll, clear the Venmo handle, confirm `preferred_payment_method` auto-flips to NULL
11. AccountPage / Documents: replace W-9, then alcohol cert; both confirm modals work, history table records both
12. Existing payday emails / SMS still fire per the staff-payments backend (no regression)

Phase B:
13. Push permission grant on Chrome desktop → subscribes successfully
14. Push permission grant on Android Chrome → subscribes successfully
15. iOS Safari without home-screen install → coachmark appears, toggles disabled
16. iOS Safari with home-screen install → permission flow works, toggles enable
17. Test BEO nudge with push-only preference → push fires, no SMS sent (assuming non-critical)
18. Test BEO finalized notification with all channels off → critical-path override sends SMS anyway
19. Subscription expires (simulate 410) → server removes the subscription on next attempt

## 12. Risk and rollback

- **Schema additions are additive and idempotent.** Rollback = `DROP COLUMN` / `DROP TABLE` per the additions in section 7. No data migration runs (the canonical handle columns already exist on `payment_profiles`), so there is no halfway-migrated state to worry about. Constraint widenings (`onboarding_status`, `scheduled_messages.channel`) are reversible by re-adding the narrower CHECK after first verifying no rows hold the new values.
- **The portal-wide replacement is high blast radius.** Every staffer's daily experience changes. Mitigations:
  - Stage to a single canary staffer (Rosa or another willing tester) before the broader cutover. Have them use the new portal in production for 3-5 events. If anything misses, fix before broader rollout.
  - Keep the 30-day redirect grace period for old URLs. A bookmarked `/dashboard` link still works (redirects to `/`).
  - The staff-payments backend already shipped; the Pay tab has real data from day one.
- **Push delivery is best-effort.** A push that fails to deliver isn't visible to the staffer. Mitigations:
  - Critical-path override (section 6.13) guarantees SMS-or-email fallback for BEO finalized / schedule changes / payday.
  - Service worker logs push events to a dev console for debug (no PII in logs).
  - On 410 Gone, `pushSender` returns `gone:true` and the dispatcher prunes the dead subscription from `staff_notification_preferences.push_subscriptions[]`.
- **Calendar feed PII surface.** The feed includes `event_location` and `client_name`. If a staffer's calendar is shared with a partner (read-access to their iCloud), that partner now sees client identities. Acceptable, bartenders typically share these details with their household anyway. Worth a one-line note in the AccountPage / Calendar sync sub: *"Your subscribed calendar shows client names and locations. Don't share the feed URL, it's the only thing protecting this data."*
- **Bank PII at rest.** `payment_profiles.routing_number` and `payment_profiles.account_number` are already AES-256-GCM ciphertext (handled by `server/utils/encryption.js`). The redesign does not change the storage model. The risk surface is the decryption path correctness: a new GET endpoint that forgets to call `decrypt()` would return raw ciphertext to the client; a PATCH that forgets to call `encrypt()` would persist plaintext that the existing read path can't make sense of. Mitigation: a small wrapper helper used by every new `payment_profiles` read/write in this redesign, plus a test that round-trips a known account number through PATCH then GET and asserts the decrypted last-4 matches.
- **Stripe / card-payment flow is unchanged.** No risk to the existing card-tip pool logic.
- **Worst-case bug:** the new ShiftDetail page fails to render a BEO. Fallback: the back button always works, the staffer can still see the shift on the Shifts/Mine list, and admin can still text them the BEO directly. No money or data corruption.

Primary surfaces to watch in production:
1. The drop / cover endpoints (real money paths if a drop accidentally fires a payroll regeneration, out of scope but possible). The `pay_periods.status='processing'` guard is the load-bearing check.
2. The notification channel routing (a misconfigured prefs JSON could silently drop notifications, test the critical-path override carefully, including the SMS + email both-off → push degradation path).
3. The push subscription lifecycle (subscriptions expire; the dispatcher must handle 410s gracefully and not retry indefinitely; verify pruning on next attempt).
4. The Twilio rate limit on cover broadcasts (a popular shift with many qualified teammates could trigger a burst; verify chunking + backoff under load).

## 13. Out of scope / follow-ups

- **Brand kit.** Asset doesn't exist; row gets added later.
- **Admin-side BEO redesign** per `admin-os/beo.jsx` (lifecycle bar + nudge preview + activity log). Real upgrade over the BEO spec's simpler buttons-on-DrinkPlanCard pattern, but deferred to its own follow-up to keep this scope focused on the staff-side.
- **Bank-PII key rotation runbook.** Encryption is shipped via `server/utils/encryption.js`, but no key-rotation procedure is documented. Land a rotation runbook in v1.5 covering: provision a new key, re-encrypt every row, verify decrypt path against the new key, then retire the old key.
- **Plaid Link for direct-deposit onboarding.** Manual routing + account entry is v1; Plaid replaces the input form in v1.5 to reduce typo-driven payment failures and to skip the staffer having to find their checks.
- **Per-bartender Stripe Connect.** Declined.
- **In-portal direct chat with admin.** Declined.
- **Post-event surveys.** Out.
- **Shift handoff notes between leads.** Out.
- **Time clock / clock-in.** Out.
- **Carpool coordination.** Out.
- **PWA install prompt UX.** v1 relies on iOS Safari's native Add to Home Screen flow via the coachmark. A first-class install prompt component lands in v1.5 if push adoption is slow.
- **Notification quiet hours.** The shape (`users.staff_notification_preferences.quiet_hours`) is reserved in the JSON; the UI hides it in v1. Add later if staff requests it.
- **Calendar sync app detection.** v1 sets `calendar_subscribed_app` based on User-Agent heuristics; a richer "Connected calendars" sub-section with multi-app status comes later if needed.
- **Document Past BEOs archive.** Removed from the Documents Other-archives section per the redesign. If staff requests viewing past BEOs from the Documents tab later, it's a small re-add.

## 14. Documentation updates (per CLAUDE.md)

Mandatory per the Mandatory Documentation Updates table in `CLAUDE.md`:

| What changed | CLAUDE.md | README.md | ARCHITECTURE.md |
|---|---|---|---|
| New route file (`staffPortal.js`) + extended `calendar.js` | n/a | Folder tree | API route table |
| New util files (`pushSender.js`, `notificationChannelResolver.js`, `staffCalendarFeedExt.js`) | n/a | Folder tree | Mention in notifications section |
| New components / pages (StaffShell, AccountPage + sub-sections, ShiftDetail, PayPage, etc.) | n/a | Folder tree | n/a |
| Schema additions (3 column adds, 2 constraint widenings, 1 new table) | n/a | n/a | Database Schema section |
| New env vars (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `REACT_APP_VAPID_PUBLIC_KEY`) | Env Variables table | Env Variables table | n/a |
| New npm script (none expected) | n/a | n/a | n/a |
| New integration (`web-push` npm) | Tech Stack list | Tech Stack table | Third-Party Integrations |
| New feature (the redesign as a whole) | n/a | Key Features | Relevant architecture sections |

`CLIENT_FACING_SURFACES.md` gets a wholesale staff-portal section rewrite reflecting the new tabs.

## 15. References

- BEO design spec: `docs/superpowers/specs/2026-05-25-beo-design.md`
- BEO implementation plan: `docs/superpowers/plans/2026-05-26-beo-implementation.md` (Phases 1-5 still applicable; Phase 6 reframed by this spec, specifically Task 29 and Task 31)
- Comms automated-communication design: `docs/superpowers/specs/2026-05-20-automated-communication-design.md` (notification topics + dispatcher patterns)
- Staff payment system design: `docs/superpowers/specs/2026-05-22-staff-payment-system-design.md` (existing payroll backend that feeds the Pay tab)
- Design source files: `Dr Bartender (6)/staff/` in user's Downloads (mockups for every surface in this spec)
