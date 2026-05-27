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

- ICS feed endpoint at `/cal/{slug}.ics` serves the staffer's confirmed shifts as VEVENT entries plus an all-day reminder 3 days before any unconfirmed BEO. Past shifts roll off after 30 days. Feed refreshes every 15 minutes (server-side cache or client-side polling, not real-time push).
- Account / Calendar sync section shows three one-tap subscribe buttons (Google Calendar, Apple Calendar, Outlook) deep-linking to the calendar app with the feed URL pre-loaded, plus the raw URL with a Copy button, plus a last-sync status block (which calendar app, how long ago, event count).
- The `slug` reuses the existing `tip_card_slug` from staff-payments. No new identifier.

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

### 5.4 Tip-card slug + handles

`MyTipPage.js` shipped: per-staffer slug, public `/tip/{slug}` page, handle editor for Venmo / Cash App / PayPal. The slug is permanent once assigned and printed on physical QR cards; this spec keeps that contract intact.

### 5.5 Schema fields already collected

`contractor_profiles` already has: `preferred_name`, `phone`, `email`, `birth_*`, `city`, `state`, `street_address`, `zip_code`, `emergency_contact_name` + `_phone` + `_relationship`, `alcohol_certification_file_url` + `_filename`, `resume_file_url`, `headshot_file_url`, equipment booleans, `travel_distance`, `reliable_transportation`. **Mailing address columns exist** (we don't need to add them; we just need to expose editing of them on the staff portal). Legal name lives on `applications.full_name` and `agreements.full_name` (NOT on contractor_profiles); reading requires a JOIN. `users.email`, `users.onboarding_status` (extended with `suspended` and `deactivated` values), `users.notifications_opt_in` (existing single boolean, replaced by the new JSONB).

### 5.6 Existing comms infrastructure

`scheduled_messages` dispatcher with `checkSuppression` (cascades on `proposals.status='archived'` etc.), `registerHandler({ offsetFromEventDate, anchor, category, priority })`, the `urgent_staffing` admin-notification category (already wired to email + SMS), `sendAndLogSms`, `notifyAdminCategory`. Phase 4a staff SMS handlers (shift_reminder, staff_thank_you, shift_unassignment_notice, etc.) already exist. The new Cover-Needed broadcasts ride this infrastructure.

## 6. Architecture

### 6.1 New shell + routes

**`client/src/components/StaffShell.js`** replaces `StaffLayout.js`. Topbar with the brand mark + name on the left, user-pill on the right. Tab nav below with the 4 tabs. Active tab persists per-tab even when an overlay (ShiftDetail / PayoutDetail / AccountPage) is open. Children area renders the active tab body.

**`client/src/components/StaffUserPillMenu.js`** is the dropdown menu opened by the user-pill button. Modal-style with a scrim. Contents:

- Top header card: 32px avatar + full name + email
- "Lighting" segmented control: House lights (sun icon) / After hours (moon icon). Changes immediately, persists to `users.ui_preferences.theme` via a `PATCH /api/me/ui-preferences` call. Click anywhere outside the segmented control to close.
- Menu items: Edit profile, Calendar sync, Notification preferences, Get support, Sign out (red).
- Each item dispatches the corresponding route: profile / payments / calendar / notif / docs sub-section, or `mailto:staff@drbartender.com`, or the sign-out action.

**URL space.** The new routes mount under `StaffSiteRoutes` (already wrapped by `RequirePortal + StaffLayout` per the spec's earlier reading of `App.js`). The wrapper changes to `RequirePortal + StaffShell`. The new mount table:

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

**Redirects from old URLs** (in `client/vercel.json` or via `<Navigate>` in `App.js`): `/dashboard` → `/`, `/events` → `/shifts/mine`, `/schedule` → `/shifts/mine`, `/profile` → `/account/profile`, `/resources` → `/account/documents`, `/my-tip-page` → `/tip-card`. 30-day grace period of redirects; remove after.

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

**Mine** sub-tab. Pending requests (status `pending`) first, then upcoming approved shifts in chronological order. Pending rows are slightly faded (`opacity: 0.85`) with a "Withdraw" button. Approved rows use the same ShiftCard as Home, with `showConfirmFlag`.

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

**Endpoints** (new, in `server/routes/shifts.js`):

- `POST /api/shifts/requests/:requestId/drop`, auto-release for 14+ day drops. Inside one transaction: SELECT request + linked shift + proposal; verify hours-to-event >= 336; UPDATE `shift_requests SET status='denied', dropped_at=NOW(), drop_reason='clean_drop'`; UPDATE the linked `shifts.status` to `'open'` if it was open with this staffer assigned (so it's available to claim again); call existing `notifyAdminCategory({ category: 'urgent_staffing', subject, emailHtml, emailText, ...(daysOut <= 7 ? { smsBody } : {}) })`. COMMIT. Return 200. If hours-to-event < 336, return 409 with `reason='wrong_mode'` (the UI shouldn't show the Drop button below that threshold; defensive).
- `POST /api/shifts/requests/:requestId/request-cover`, sets `shift_requests.cover_requested_at = NOW()` plus an optional `cover_reason` text. Staffer remains `status='approved'`. Notify management (urgent_staffing, email always, SMS if `daysOut <= 7`). Broadcasts via the dispatcher: a `cover_broadcast` message to every other staffer who has opted-in for the `cover_needed` category and who is qualified for the shift (positions_needed match their role in `applications.positions_interested`).
- `POST /api/shifts/requests/:shiftId/claim-cover`, a teammate claims a cover. Inserts a new `shift_requests` row with `status='pending'`. Management gets a one-click "Approve this cover swap" email. On approval (via existing `PUT /api/shifts/requests/:requestId` with status='approved'), the original staffer's row flips to `status='denied'`, the original `cover_requested_at` is cleared, the broadcast dispatcher rows are suppressed for the rest of the team, and the new staffer's row becomes the active one. The existing assign / approve cascade fires (scheduleStaffShiftMessages, BEO nudge insertion if finalized).
- `POST /api/shifts/requests/:requestId/emergency-drop`, body requires `{ reason: string (min 10 chars) }`. Inside one transaction: SELECT context, verify hours-to-event < 72 (defensive); UPDATE the request with `dropped_at=NOW()`, `drop_reason=reason`, `drop_emergency=true`; leave `status='approved'` (management resolves manually); notify management urgently (email + SMS regardless of days-out, since emergency); INSERT into `proposal_activity_log` with `action='emergency_drop_requested'`, `actor_type='staff'`, `actor_id=user.id`, `details={reason, hours_out}`. COMMIT. Return 200.

All four endpoints are `auth`-gated and additionally check `req.user.id === shift_requests.user_id` (you can only drop your own shifts; admin uses a different path).

### 6.6 PayPage

Top hero "My Pay" + sub-line. Current pay period banner (large total + payday + status chip Processing / Paid). Line items for the current period (each event is a `PayoutEventRow` that expands to show wage / gratuity / card-tip / adjustment breakdown). Year-to-date roll-up card. Paystubs list of paid periods.

Tapping a line in the current period or paid history opens **PayoutDetail** for that pay period.

Data: existing staff-payments endpoints (`GET /api/me/payouts` returning the list, `GET /api/me/payouts/:periodId` returning the detail). No new endpoints.

### 6.7 PayoutDetail page

A single pay period with all line items. Accepts an optional `?shift=:shiftId` query param: when present, scroll to and highlight the matching event card (`sp-highlight` class on the card).

Layout: back button to Pay; title (Paystub or Period preview); period range + event count; banner with total + status chip; Summary card (wages / gratuity / card tips gross / card processing fee / adjustments / payout total); per-event detail cards (one per `payout_events` row), each card showing wage breakdown, gratuity share, card-tip gross + fee, adjustments; pay actions (Download PDF if paid, Email a copy); a small italic 1099 reminder at the bottom.

### 6.8 TipCardPage

Top hero "Tip Card" + sub-line. The QR card preview (existing FakeQR-style render of the print card). Row of action buttons: Open print page, Share link, Copy URL.

"Tips received this week" card listing recent tips (existing data from `RECENT_TIPS_ST` shape, fed by an endpoint per the existing MyTipPage).

**"How it's shown on your card"** reorder card:

- Sub-line: *"Drag (or use the arrows) to reorder. Top of the list shows first on the printed card and on the /tip/{slug} chooser page."*
- One row per tip-eligible method on file (always-on card payments, plus Venmo / Cash App / PayPal / Zelle if added). Each row: drag grip + method icon + label + handle text (mono) + up/down arrow buttons (for accessibility, keyboard / screen-reader users).
- "Manage methods →" link in the card head opens AccountPage / Payments.

Reorder persists immediately on drag-end or arrow-tap to `users.ui_preferences.tip_card_order` (a JSON array of method-id strings).

**No "Tips route to" pill** on this page. Preferred-for-tips does not exist as a concept (the QR opens a chooser).

### 6.9 AccountPage shell

A single overlay component with a horizontal sub-nav (Profile / Payment methods / Calendar sync / Notifications / Documents). Each sub-section is its own React component swapped in. Header is the user's avatar + name + role + email. Footer is the Sign-out button + the help-email line.

### 6.10 AccountPage / Profile

Personal info card with:

- Preferred name + Legal name (legal is read-only, lock icon, helper text linking to staff@drbartender.com)
- Email + Phone (with mono font and SMS sub-helper)
- Mailing address (full width, "For 1099 forms in January" sub-helper)
- Emergency contact sub-section: Name + Phone + Relationship in one row

Save button in the card header. On save, posts to `PATCH /api/me/profile` updating the relevant `contractor_profiles` columns plus the `users.email` if changed (with the existing email-change confirmation flow if it exists, or noted as a follow-up).

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

**Data model.** Replace the flat columns `contractor_profiles.venmo` / `cashapp` / `paypal_url` / etc. with a dedicated `staff_payment_methods` table:

```sql
CREATE TABLE IF NOT EXISTS staff_payment_methods (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(50) NOT NULL CHECK (kind IN ('venmo', 'cashapp', 'paypal', 'zelle', 'direct_deposit', 'check')),
  handle VARCHAR(500),                 -- @rosa, $rosa, paypal.me/x, email/phone for Zelle; null for check
  bank_routing_encrypted VARCHAR(500), -- direct_deposit only, encrypted via server/utils/encryption.js
  bank_account_encrypted VARCHAR(500), -- direct_deposit only, encrypted
  bank_account_last4 VARCHAR(4),       -- last 4 of the account # for masked display
  is_preferred_payroll BOOLEAN DEFAULT false,
  display_order INTEGER,               -- for the tip card chooser ordering (NULL for payroll-only)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, kind, handle)       -- prevent duplicate handles for the same user/kind
);
CREATE INDEX IF NOT EXISTS idx_spm_user ON staff_payment_methods(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spm_preferred_payroll_unique
  ON staff_payment_methods(user_id) WHERE is_preferred_payroll = true;
```

Migration: a one-time pass copies the existing flat handle columns from `contractor_profiles` into rows of `staff_payment_methods`, then the flat columns are deprecated (kept for one release for safety, dropped in a follow-up). The existing `users.payment_handles` JSON (if any) on the staff-payments side is the canonical pre-migration source.

The Card payments row is conceptual, it's a row in the UI that does not correspond to a `staff_payment_methods` table row. The UI always renders it. Tip card display order persists in `users.ui_preferences.tip_card_order` as the array of method IDs the user has actively reordered (Card always implied in the list, position determined by where the user placed the literal `'card'` token in the order array, or first if absent).

**Endpoints:**

- `GET /api/me/payment-methods`, returns the staffer's methods array plus the always-on card-payment row in the canonical position per their saved order.
- `POST /api/me/payment-methods`, creates a new row.
- `PATCH /api/me/payment-methods/:id`, updates handle / routing / account / is_preferred_payroll. When `is_preferred_payroll=true` is set, the route runs in a transaction that flips the previously-preferred row to false (the partial unique index above is defense-in-depth).
- `DELETE /api/me/payment-methods/:id`, removes. If the removed row was preferred-payroll, the route auto-promotes the first remaining payroll-eligible method to preferred. If no payroll-eligible methods remain, payroll stays unset (admin gets a notification on the next pay run; out of scope for v1 to auto-handle).
- `PUT /api/me/tip-card-order`, body is `{ order: ['card', 'venmo', ...] }`. Saves to `users.ui_preferences.tip_card_order`. Validates that every method in the order array maps to an existing payment method (or `'card'`); rejects with 400 otherwise.

### 6.12 AccountPage / Calendar sync

Three subscribe buttons:

- Google Calendar (deep link: `https://calendar.google.com/calendar/r?cid=<encoded https feed url>`)
- Apple Calendar (deep link: `webcal://staff.drbartender.com/cal/{slug}.ics`)
- Outlook (deep link to Outlook's subscription URL with the feed pre-filled)

Subscription URL block below the buttons: read-only URL + a Copy button (toggles to a "Copied" checkmark for 1.8 seconds).

Footer note: *"Refreshes every 15 minutes. Includes all confirmed shifts, plus an all-day reminder 3 days before any unconfirmed BEO. Past shifts roll off after 30 days."*

"Last sync" sub-section: shows which calendar app subscribed (detected via referrer or stored in `users.ui_preferences.calendar_subscribed_app`), how long ago it pulled the feed (server tracks `last_ics_fetch_at` per slug), and an event count. A Disconnect button clears the tracked state.

**ICS feed endpoint** at `GET /api/cal/{slug}.ics`. Public route (the slug is the auth, same model as `/tip/{slug}`). Returns text/calendar with a stable PRODID. VEVENT entries:

- Every approved shift_request on a non-cancelled shift in the future, plus past shifts within the last 30 days.
- Each shift becomes a VEVENT with DTSTART = shift_event_start, DTEND = shift_event_end, SUMMARY = client name + event type, LOCATION = event_location, DESCRIPTION = role + setup notes + a deep link to `https://staff.drbartender.com/shifts/{id}`.
- Plus an all-day VEVENT 3 days before any unconfirmed BEO (one all-day VEVENT per affected shift, with TRANSP:TRANSPARENT so it doesn't block the day visually): SUMMARY = "Confirm BEO: [client]", DESCRIPTION includes the link.

Cache header: `Cache-Control: private, max-age=900` (15 min). On every fetch, server updates `users.last_ics_fetch_at = NOW()` and `users.ui_preferences.calendar_subscribed_app` based on the User-Agent (Google fetches from `Calendar.google.com`, Apple from `iCal/macOS` or `iOS/`, Outlook from `Microsoft Office/Outlook`).

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

**Backend.** Add a JSONB column `users.notification_preferences` with the per-category × per-channel toggle state plus a sub-object for push subscriptions:

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

Endpoints:

- `GET /api/me/notification-preferences`, returns the JSONB plus the browser-permission-state-derived flags (server can't know browser state, so the client computes those locally and the GET just returns saved prefs).
- `PATCH /api/me/notification-preferences`, partial update. Body merges into the existing JSONB. Use `jsonb_set` for atomic per-key updates so concurrent saves from multiple devices don't clobber.
- `POST /api/me/push-subscriptions`, body is a `PushSubscription` JSON from the browser. Append to the `push_subscriptions` array. Returns 200.
- `DELETE /api/me/push-subscriptions`, body is `{ endpoint: '...' }`. Remove the matching subscription.

**Critical-path override.** Three categories are critical: `beo_finalized`, `schedule_change`, `payday`. The dispatcher's channel-routing helper (`pickChannelsForUserAndCategory(userId, category)`) enforces: if ALL of a critical category's channels are toggled off in the user's prefs, fall back to a single deterministic channel (SMS for shift-related, email for payday). The UI surfaces this with the footer copy: *"Critical-path messages. BEO finalized, schedule changes, payday, can't be fully muted. We'll deliver them through whatever channel is still on."*

**Dispatcher integration.** Extend `scheduleMessage` and the dispatcher's per-row send logic:

- When inserting a `scheduled_messages` row for a categorized event, the route or scheduler stores the `category` (existing) but does NOT pre-resolve the channel. Instead it stores `channel='auto'`.
- At dispatch time, the dispatcher calls `pickChannelsForUserAndCategory` to resolve the actual channel(s). If push is preferred AND the user has an active subscription, try push first; on failure (subscription expired / unreachable), fall back to the next channel in priority order (SMS > email).
- Existing rows with explicit `channel='sms'` continue to work as before (no auto-resolve).

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

**Replace flow:**

1. Tap the Replace pencil icon on a replaceable row → opens the ReplaceConfirmModal.
2. Modal title: "Replace your [W-9 / alcohol certification]?"
3. Modal sub: "The new file becomes your active record. Choose a PDF or photo."
4. File picker (accept `.pdf,.png,.jpg,.jpeg`); after selection, the chosen file's name + size shows in the modal.
5. Buttons: Cancel / Replace (primary, disabled until a file is chosen).
6. On Replace, POST to `POST /api/me/documents/:doc_type/replace` (multipart). Backend uploads the new file to R2, sets the new URL on `contractor_profiles` for the active record, and appends an entry to a new `staff_document_history` table:

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
5. Backend appends to `users.notification_preferences.push_subscriptions[]`.

**Sending:**

- New util `server/utils/pushSender.js` exports `sendPush({ subscription, title, body, url, tag, icon })`. Uses `web-push` npm.
- On dispatch, the dispatcher calls `pushSender.sendPush` per subscription. On 410 Gone or 404, removes the subscription from the user's prefs (it's expired).
- Push notification payload includes a `tag` for grouping (one tag per category, so successive shift-reminder pushes replace the previous) and a `url` (the deep link to open on tap).

**Service-worker click handler** opens or focuses the staff portal at the URL in the payload. Standard pattern.

### 6.18 Team roster on GET BEO

The BEO spec's `GET /api/beo/:proposalId` response includes a `shift_requests` array. Extend the projection to include the team roster as a derived field per the design's `team_roster[]` shape:

- For each approved shift_request on a non-cancelled shift linked to the proposal:
  - `user_id`
  - `name` (full name from `users` / `applications` for first + last initial computation client-side)
  - `initials` (computed from name; both first letters)
  - `is_me` boolean (true when `user_id === req.user.id`)
  - `role` from `shift_requests.position` (defaulting to 'Bartender' when null)
  - `phone` from `contractor_profiles.phone` (E.164 or formatted)
  - `needs_cover` boolean (true when `shift_requests.cover_requested_at IS NOT NULL`)

Phone is teammate PII visible to anyone on the same gig, fine for coworkers (already exposed via `shift_reminder` SMS) but the BEO response surface widens slightly per the BEO spec section 7.1.

## 7. Schema additions

All idempotent and additive. No data loss.

```sql
-- Theme + tip-card order + calendar subscription tracking
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_preferences JSONB DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ics_fetch_at TIMESTAMPTZ;

-- Notification preferences with push subscription storage
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preferences JSONB DEFAULT '{}'::jsonb;
-- The existing notifications_opt_in BOOLEAN column is preserved for backwards
-- compatibility; one-time migration copies its value into the new prefs JSON.

-- Drop / cover marketplace
ALTER TABLE shift_requests
  ADD COLUMN IF NOT EXISTS cover_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cover_reason TEXT,
  ADD COLUMN IF NOT EXISTS dropped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS drop_reason TEXT,
  ADD COLUMN IF NOT EXISTS drop_emergency BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_shift_requests_cover_requested
  ON shift_requests(cover_requested_at) WHERE cover_requested_at IS NOT NULL;

-- Payment methods table (replacing the flat contractor_profiles handle columns)
CREATE TABLE IF NOT EXISTS staff_payment_methods (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(50) NOT NULL CHECK (kind IN ('venmo', 'cashapp', 'paypal', 'zelle', 'direct_deposit', 'check')),
  handle VARCHAR(500),
  bank_routing_encrypted VARCHAR(500),
  bank_account_encrypted VARCHAR(500),
  bank_account_last4 VARCHAR(4),
  is_preferred_payroll BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, kind, handle)
);
CREATE INDEX IF NOT EXISTS idx_spm_user ON staff_payment_methods(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spm_preferred_payroll_unique
  ON staff_payment_methods(user_id) WHERE is_preferred_payroll = true;

DROP TRIGGER IF EXISTS update_staff_payment_methods_updated_at ON staff_payment_methods;
CREATE TRIGGER update_staff_payment_methods_updated_at BEFORE UPDATE ON staff_payment_methods
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Alcohol certification expiry tracking
ALTER TABLE contractor_profiles
  ADD COLUMN IF NOT EXISTS alcohol_certification_expires_on DATE;

-- Document replace history
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

-- W-9 file URL: confirm it exists (if not, add)
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS w9_file_url VARCHAR(500);
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS w9_filename VARCHAR(255);
```

**Migrations from existing data.** A one-time data migration (run once after the schema is in place):

```sql
-- Seed staff_payment_methods from existing contractor_profiles / users.payment_handles
INSERT INTO staff_payment_methods (user_id, kind, handle, is_preferred_payroll)
SELECT
  u.id,
  unnest(ARRAY['venmo', 'cashapp', 'paypal']),
  unnest(ARRAY[u.payment_handles->>'venmo', u.payment_handles->>'cashapp', u.payment_handles->>'paypal_url']),
  false
FROM users u
WHERE u.payment_handles IS NOT NULL AND u.role = 'staff';
-- Then a follow-up UPDATE to set is_preferred_payroll=true on the row matching users.payment_handles->>'preferred_method'.

-- Seed notification_preferences from notifications_opt_in
UPDATE users SET notification_preferences = jsonb_build_object(
  'channels', jsonb_build_object(
    'shift_offered',     CASE WHEN notifications_opt_in THEN '["sms","email"]'::jsonb ELSE '[]'::jsonb END,
    'shift_decided',     CASE WHEN notifications_opt_in THEN '["sms"]'::jsonb           ELSE '[]'::jsonb END,
    'cover_needed',      '[]'::jsonb,
    'beo_finalized',     CASE WHEN notifications_opt_in THEN '["sms","email"]'::jsonb ELSE '[]'::jsonb END,
    'beo_reminder_t3',   CASE WHEN notifications_opt_in THEN '["sms"]'::jsonb           ELSE '[]'::jsonb END,
    'schedule_change',   CASE WHEN notifications_opt_in THEN '["sms","email"]'::jsonb ELSE '[]'::jsonb END,
    'payday',            CASE WHEN notifications_opt_in THEN '["sms","email"]'::jsonb ELSE '[]'::jsonb END,
    'tip_received',      '[]'::jsonb
  ),
  'push_subscriptions', '[]'::jsonb
)
WHERE notification_preferences = '{}'::jsonb OR notification_preferences IS NULL;
```

## 8. Files

### 8.1 Server (new)

- `server/routes/staffPortal.js`, composite endpoints used by Home and other pages: `GET /api/me/staff-home`, `GET /api/me/payment-methods`, `POST /api/me/payment-methods`, `PATCH /api/me/payment-methods/:id`, `DELETE /api/me/payment-methods/:id`, `PUT /api/me/tip-card-order`, `PATCH /api/me/profile`, `PATCH /api/me/ui-preferences`, `GET /api/me/notification-preferences`, `PATCH /api/me/notification-preferences`, `POST /api/me/push-subscriptions`, `DELETE /api/me/push-subscriptions`, `POST /api/me/documents/:doc_type/replace`.
- `server/routes/calendar.js` (or extend the existing one), `GET /api/cal/:slug.ics` public endpoint returning the ICS feed.
- `server/utils/pushSender.js`, wraps `web-push` npm.
- `server/utils/notificationChannelResolver.js`, `pickChannelsForUserAndCategory(userId, category)` with critical-path override.
- `server/utils/icsFeedBuilder.js`, composes VEVENT entries from a staffer's shifts.
- `server/routes/staffPortal.test.js`, endpoint contract tests.
- `server/utils/pushSender.test.js`, `server/utils/notificationChannelResolver.test.js`, `server/utils/icsFeedBuilder.test.js`.

### 8.2 Server (modify)

- `server/db/schema.sql`, all schema additions in section 7.
- `server/routes/shifts.js`, new drop / cover endpoints (`POST /requests/:id/drop`, `/request-cover`, `/claim-cover`, `/emergency-drop`). The existing routes also gain projection updates for the new pages: `GET /shifts` (staff path) adds `drink_plan_finalized_at`, `my_beo_acknowledged_at`, `cover_requested_at`, `cover_for_first_initial`; `GET /shifts/user/:userId/events` adds `payout_id` per past row (computed via a join to `payout_events`).
- `server/utils/scheduledMessageDispatcher.js`, dispatch-time channel resolution: when a row's `channel='auto'`, call `notificationChannelResolver.pickChannelsForUserAndCategory`. Try push first if granted + subscribed, fall back to SMS / email per the resolved list. Existing explicit-channel rows unaffected.
- `server/index.js`, mount `/api/me/*`, `/api/cal/*`.
- `server/utils/staffShiftHandlers.js`, cover-broadcast scheduling helper: when a `request-cover` endpoint fires, schedule one `cover_broadcast` scheduled_messages row per opted-in qualified teammate.
- `server/utils/smsTemplates.js`, new `cover_broadcast_sms` template + `staff_drop_to_management_sms` for the management-side urgent notifications on emergency drops.
- `server/routes/me.js` (existing), `GET /api/me` extended to include `notification_preferences`, `ui_preferences`, payment methods list, on a single payload so the StaffShell can render without multiple GETs.

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

- `client/src/App.js`, replace the staff route block. Old routes get `<Navigate to=... replace>` redirects for the 30-day grace period.
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
- `ARCHITECTURE.md`, route table (all the new `/api/me/*` and `/api/cal/:slug.ics` rows), schema section (new tables + columns), notifications model section (channel-routing).
- `CLIENT_FACING_SURFACES.md`, staff portal section overhaul.

## 9. Phasing

**Phase A. Portal shell + BEO embedding + drop/cover marketplace (SMS only).** Ship the new 4-tab portal with all the pages, the AccountPage (Profile / Payment methods / Calendar sync / Documents, minus push for notifications), the drop/cover flow with email + SMS to management. BEO content embeds inside ShiftDetail. Light/dark theme persists. Tip Card drag-reorder works. The Notifications page exists but the Push column is disabled across all rows (banner: "Coming in v1.5"). All existing SMS / email touches continue working via the existing dispatcher path with explicit channels.

**Phase B. Push notifications + channel routing.** Adds the service worker, VAPID setup, push subscriptions, `pushSender.js`, the channel-routing helper, and the dispatcher's auto-resolve logic. The Push column on Notifications activates. iOS coachmark goes live. Existing SMS / email touches stay unchanged unless the user opts in to push for that category.

Phase A is ~3-4 weeks of focused work. Phase B is ~1 week. Both ship as separate merges to main.

## 10. Authorization

- All `/api/me/*` endpoints are `auth`-gated and scope every read/write by `req.user.id`. IDOR guard is in the query (`WHERE user_id = $1`), not by trusting body params.
- The four drop/cover endpoints additionally verify `req.user.id === shift_requests.user_id` (you can only drop your own; admin uses different routes).
- The ICS feed `GET /api/cal/:slug.ics` is public (slug is the auth, matching the existing `/tip/:slug` pattern). Slug is a hard-to-guess UUID-like string already.
- Push subscription PII (`endpoint` URL, `keys`) is stored in plaintext in `users.notification_preferences.push_subscriptions[]`. This is the standard Web Push pattern; the keys are recipient-public (used by the server to encrypt the payload, but they don't grant access to anything beyond sending notifications to that endpoint). No encryption required.
- Bank routing + account numbers in `staff_payment_methods` use the existing `server/utils/encryption.js` AES-256-GCM pattern. Per CLAUDE.md, "fails closed in prod", if encryption fails, the route returns 5xx and never stores plaintext.

## 11. Testing approach

**Server unit tests** (node:test, real dev DB per existing pattern):

- `staffPortal.test.js`:
  - `GET /api/me/staff-home` composes the four sections correctly
  - `GET /api/me/payment-methods` returns the staffer's methods plus the implied card-payments row in the right position
  - `POST` / `PATCH` / `DELETE /api/me/payment-methods/*` with transition-correctness (preferred-payroll uniqueness, auto-promote on delete-of-preferred)
  - `PUT /api/me/tip-card-order` validates order against the user's methods
  - `PATCH /api/me/notification-preferences` partial update via `jsonb_set`
  - `POST /api/me/documents/:doc_type/replace` writes to history table + flips the active URL
  - All endpoints respect IDOR (a staffer cannot read or mutate another staffer's data)
- `shifts.test.js` additions:
  - `POST /requests/:id/drop` succeeds at 14+ days, returns 409 at 13d 23h
  - `POST /requests/:id/request-cover` sets `cover_requested_at`, schedules cover_broadcast rows for opted-in qualified teammates
  - `POST /requests/:shiftId/claim-cover` creates a new pending request and notifies management
  - `POST /requests/:id/emergency-drop` requires `reason` >= 10 chars, returns 400 below, succeeds at < 72h
  - `urgent_staffing` admin notification fires email always + SMS when days_out <= 7
- `notificationChannelResolver.test.js`:
  - Returns the user's opted-in channels for a category
  - Critical-path override fires when all channels for `beo_finalized` / `schedule_change` / `payday` are off
  - Returns empty for unsupported categories (defensive)
- `pushSender.test.js`:
  - Sends a push successfully (mocked web-push)
  - On 410 Gone, removes the subscription from the user's prefs
  - Handles invalid subscription gracefully
- `icsFeedBuilder.test.js`:
  - Includes future confirmed shifts as VEVENT entries
  - Includes past shifts within 30 days
  - Includes all-day BEO unconfirmed reminders 3 days before
  - Returns a valid ICS document (no malformed PRODID, correct CRLF line endings)
- `scheduledMessageDispatcher.test.js` additions:
  - `channel='auto'` row resolves at dispatch via `notificationChannelResolver`
  - Push attempted first when granted+subscribed; falls back to SMS on 410
  - Critical-path override sends via SMS when the user has muted all channels for `beo_finalized`

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
9. Tip Card drag-reorder persists, shows correctly on /tip/{slug} chooser page (existing public route reads from the new order)
10. AccountPage / Payment methods: add Venmo, set as preferred for payroll, remove it (auto-promotes next eligible)
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

- **Schema additions are additive and idempotent.** Rollback = `DROP COLUMN` / `DROP TABLE` per the additions in section 7. Worst-case partial rollback during Phase A: deleted columns leave dangling JSONB keys in `notification_preferences`, which are harmless.
- **Data migration from `payment_handles` JSON into `staff_payment_methods` is one-way.** Keep the old `users.payment_handles` JSON in place for one release cycle as the safe-rollback path. After v1 stability is confirmed, drop the JSON.
- **The portal-wide replacement is high blast radius.** Every staffer's daily experience changes. Mitigations:
  - Stage to a single canary staffer (Rosa or another willing tester) before the broader cutover. Have them use the new portal in production for 3-5 events. If anything misses, fix before broader rollout.
  - Keep the 30-day redirect grace period for old URLs. A bookmarked `/dashboard` link still works (redirects to `/`).
  - Roll out the staff-payments side (existing) ahead of the redesign so the Pay tab has data to render against on day one.
- **Push delivery is best-effort.** A push that fails to deliver isn't visible to the staffer. Mitigations:
  - Critical-path override (section 6.13) guarantees SMS-or-email fallback for BEO finalized / schedule changes / payday.
  - Service worker logs push events to a dev console for debug (no PII in logs).
  - On 410 Gone, the subscription is auto-removed (handled in `pushSender.js`).
- **ICS feed PII surface.** The feed includes event_location, client_name. If a staffer's calendar is shared with a partner (read-access to their iCloud), that partner now sees client identities. Acceptable, bartenders typically share these details with their household anyway. Worth a one-line note in the AccountPage / Calendar sync sub: *"Your subscribed calendar shows client names and locations. Don't share the feed URL, it's the only thing protecting this data."*
- **Stripe / card-payment flow is unchanged.** No risk to the existing card-tip pool logic.
- **Worst-case bug:** the new ShiftDetail page fails to render a BEO. Fallback: the back button always works, the staffer can still see the shift on the Shifts/Mine list, and admin can still text them the BEO directly. No money or data corruption.

Primary surfaces to watch in production:
1. The drop/cover endpoints (real money paths if a drop accidentally fires a payroll regeneration, out of scope but possible).
2. The notification channel routing (a misconfigured prefs JSON could silently drop notifications, test the critical-path override carefully).
3. The payment methods migration (data integrity, verify every existing handle landed in the new table).
4. The push subscription lifecycle (subscriptions expire; the dispatcher must handle 410s gracefully and not retry indefinitely).

## 13. Out of scope / follow-ups

- **Brand kit.** Asset doesn't exist; row gets added later.
- **Admin-side BEO redesign** per `admin-os/beo.jsx` (lifecycle bar + nudge preview + activity log). Real upgrade over the BEO spec's simpler buttons-on-DrinkPlanCard pattern, but deferred to its own follow-up to keep this scope focused on the staff-side.
- **Plaid Link for direct-deposit onboarding.** Manual routing+account entry (encrypted) is v1; Plaid replaces the input form in v1.5 if the UX friction warrants.
- **Per-bartender Stripe Connect.** Declined.
- **In-portal direct chat with admin.** Declined.
- **Post-event surveys.** Out.
- **Shift handoff notes between leads.** Out.
- **Time clock / clock-in.** Out.
- **Carpool coordination.** Out.
- **PWA install prompt UX.** v1 relies on iOS Safari's native Add to Home Screen flow via the coachmark. A first-class install prompt component lands in v1.5 if push adoption is slow.
- **Notification quiet hours.** The shape (`users.notification_preferences.quiet_hours`) is reserved in the JSON; the UI hides it in v1. Add later if staff requests it.
- **Calendar sync app detection.** v1 sets `calendar_subscribed_app` based on User-Agent heuristics; a richer "Connected calendars" sub-section with multi-app status comes later if needed.
- **Document Past BEOs archive.** Removed from the Documents Other-archives section per the redesign. If staff requests viewing past BEOs from the Documents tab later, it's a small re-add.

## 14. Documentation updates (per CLAUDE.md)

Mandatory per the Mandatory Documentation Updates table in `CLAUDE.md`:

| What changed | CLAUDE.md | README.md | ARCHITECTURE.md |
|---|---|---|---|
| New route files (`staffPortal.js`, `calendar.js` extension) |, | Folder tree | API route table |
| New util files (`pushSender.js`, `notificationChannelResolver.js`, `icsFeedBuilder.js`) |, | Folder tree | Mention in notifications section |
| New components / pages (StaffShell, AccountPage + sub-sections, ShiftDetail, PayPage, etc.) |, | Folder tree |, |
| Schema additions (3 ALTERs, 2 new tables) |, |, | Database Schema section |
| New env vars (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `REACT_APP_VAPID_PUBLIC_KEY`) | Env Variables table | Env Variables table |, |
| New npm script (none expected) |, |, |, |
| New integration (`web-push` npm) | Tech Stack list | Tech Stack table | Third-Party Integrations |
| New feature (the redesign as a whole) |, | Key Features | Relevant architecture sections |

`CLIENT_FACING_SURFACES.md` gets a wholesale staff-portal section rewrite reflecting the new tabs.

## 15. References

- BEO design spec: `docs/superpowers/specs/2026-05-25-beo-design.md`
- BEO implementation plan: `docs/superpowers/plans/2026-05-26-beo-implementation.md` (Phases 1-5 still applicable; Phase 6 reframed by this spec, specifically Task 29 and Task 31)
- Comms automated-communication design: `docs/superpowers/specs/2026-05-20-automated-communication-design.md` (notification topics + dispatcher patterns)
- Staff payment system design: `docs/superpowers/specs/2026-05-22-staff-payment-system-design.md` (existing payroll backend that feeds the Pay tab)
- Design source files: `Dr Bartender (6)/staff/` in user's Downloads (mockups for every surface in this spec)
