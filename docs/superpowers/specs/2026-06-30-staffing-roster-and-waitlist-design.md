# Staffing roster derivation and waitlist

Date: 2026-06-30
Status: Approved design, ready for implementation plan

## Problem

Two related gaps in how events get staffed.

**1. Shifts are only created for bartenders.** Today an event gets exactly one `shifts` row, and its slot count (`positions_needed`, a JSON array) is built from `proposals.num_bartenders` alone, filled entirely with the string `"Bartender"`. Banquet servers and barbacks are priced and paid for as `service_addons` (category `staffing`), but they never become shift slots. Worse, bartenders added through the `additional-bartender` add-on path (rather than the `num_bartenders` stepper) are also dropped, because the two channels are additive and only the first is read. Result: a client can pay for 2 bartenders and a banquet server and the system creates 2 bartender slots and zero server slots. The requirement is simple: if the event shows and the client paid for 2 bartenders and a banquet server, there must be 2 bartender slots and 1 server slot, regardless of how or when those roles were added to the booking.

**2. No "staffed" signal and no waitlist.** The schema has a `filled` status for shifts, but no code path ever sets it, so a fully staffed event never leaves `status = 'open'` and keeps appearing in the staff "Available" list with a live Request button. There is no way for staff to see that an event is already staffed, no way to join a waitlist behind a full event, and no admin view of who is waiting in the wings.

## Goals

- One source of truth that derives the full per-role staffing roster for a proposal and feeds every path that builds shift slots.
- Staff can see staffed events, request open roles (ranked by preference), join a waitlist when an event is full, and remove themselves from that waitlist.
- Admin can see the waitlist (who is in the wings, and for which roles) and pull from it.
- Reuse the existing assignment and notification paths. Do not disturb the working cover/drop marketplace or the money-adjacent code.

## Non-goals (deferred, see Future work)

- Auto-promotion from the waitlist when a slot opens. Promotion is manual this pass.
- Merging the waitlist into the cover/drop broadcast pool.
- Hard capability gating of which roles a staffer may request (we trust self-selection plus admin approval).
- Showing waitlisted staff their position or the names of other waiting staff.

## Vocabulary

Canonical role labels, used uniformly across `positions_needed`, the request payload, and the admin assign dropdown:

- `Bartender`
- `Banquet Server`
- `Barback`

The admin assign dropdown currently offers `Server`; it changes to `Banquet Server`. Any legacy `shift_requests.position = 'Server'` rows are normalized to `Banquet Server`.

---

## Section 1: Staffing roster derivation

### `deriveStaffingRoster(proposal)`

A single function returns an ordered array of canonical role labels representing every slot the client paid for. Order is Bartenders, then Banquet Servers, then Barbacks, so `positions_needed` reads cleanly, for example `["Bartender","Bartender","Banquet Server"]`.

Per-role headcount:

- **Bartenders** = `proposals.num_bartenders` plus the `additional-bartender` add-on headcount. These are two independent, additive channels. `num_bartenders` mirrors `pricing_snapshot.staffing.actual` and already folds in the hosted-package 1:100 ratio. The `additional-bartender` add-on is separate and is never reflected in `num_bartenders`. They must be summed and never substituted for one another (the pricing engine sums them in `pricingEngine.js`).
- **Banquet Servers** = `banquet-server` add-on headcount.
- **Barbacks** = `barback` add-on headcount.

Headcount recovery: staffing add-on quantities are stored in hours, not people (`proposal_addons.quantity = max(event_duration_hours, 4) * headcount`). Recover headcount preferentially from `pricing_snapshot.addons[]`, which carries both `slug` and the hours quantity, dividing by the snapshot duration exactly as `gratuityBasisFromSnapshot` already does. Fallback when the snapshot is missing or lacks the entries: join `proposal_addons` to `service_addons` on `addon_id` (note `proposal_addons` has no `slug` column), guarding NULL `addon_id` on legacy rows by matching `addon_name`, and divide by `max(event_duration_hours, 4)`.

Notes:

- Class packages (`bar_type = 'class'`) zero the bartender charges but the headcount is still real. The derivation reads counts, not prices, so this is handled.
- Parse `positions_needed` with `JSON.parse` plus a fallback to `[]`; never call `Array.isArray` on the raw string. Normalize malformed values to `[]`.

### Wiring

Both slot-building paths route through `deriveStaffingRoster`:

- `createEventShifts` (in `server/utils/eventCreation.js`) replaces the current `Array(num_bartenders).fill('Bartender')`.
- `syncShiftsFromProposal` (runs on every proposal edit) replaces the bartender-only reconcile.

`syncShiftsFromProposal` becomes **per-role shrink-capped**: a role's slot count never drops below the number of already-approved, non-dropped assignments for that role. When the desired count for a role is below its approved count, keep the approved count and log `staffing_shrink_capped` to `proposal_activity_log`, the same as the bartender-only logic does today, but now per role.

Because both creation (Stripe webhook, manual conversion) and edit (`syncShiftsFromProposal`) funnel through the one derivation, the roster is correct "regardless of how or when" a role is added, and the silent `additional-bartender` drop is fixed.

---

## Section 2: Staff-facing UI

### Tabs (`client/src/pages/staff/ShiftsPage.js`)

`Mine` and `Past` stay. The top two are reframed:

- **Available**: events with at least one open slot. Fullness is computed from approved-active assignments versus `positions_needed`, not from the never-set `status = 'filled'`. This also fixes the leak where staffed events lingered here.
- **All**: every upcoming event, including fully staffed ones. This is the surface that shows staffed events.

### Event card

Shows per-role fill, for example `Bartender 2/2 done · Banquet Server 0/1`. The action button is context-aware at the event level:

- Open slots: **Request**
- Fully staffed (every role full): **Join waitlist**, with a "Fully staffed" chip so it is obvious before tapping.

### Request flow

The sheet that opens on Request or Join waitlist:

- Lists the roles the event needs with their fill status.
- The staffer checks the roles they are willing and able to work (self-selection; the system does not filter by stored qualification this pass).
- If they pick more than one role, they drag to rank them by preference.
- Submitting writes (upserts) a `shift_requests` row with the ordered `requested_positions` and `status = 'pending'`.
- The submit copy reflects the staffer's actual selection: if every role they picked is full, it reads "Join waitlist"; otherwise "Request". This is honest even on a partially staffed event where the staffer happens to want only a full role.

Server validation: `requested_positions` must be a non-empty, de-duplicated subset of the distinct roles the event needs. Re-submitting upserts on the existing `UNIQUE(shift_id, user_id)` row, letting a staffer change their willing roles or ranking while still pending.

---

## Section 3: Waitlist

### Representation: a computed view, not a new status

Requests keep the existing statuses `pending`, `approved`, `denied`. There is no enum migration and no background reconciliation job.

A `pending` request is classified **waitlisted** if and only if none of its ranked roles currently has an open slot; otherwise it is **actionable**. Per role, `remaining[role] = needed[role] - approvedActive[role]`, where `approvedActive` counts `status = 'approved' AND dropped_at IS NULL` grouped by `position`. A request is actionable if any role in its `requested_positions` has `remaining > 0`. The event is fully staffed when every role's `remaining` is zero.

The load-bearing consequence: the moment a slot frees (a drop, an admin removal, or the client adding capacity), the same pending row reclassifies from waitlisted to actionable automatically, with nothing to flip and no race. The waitlist promotes itself into the admin's approvable queue. This is what makes manual promotion cost no new moving parts.

A single canonical helper computes this classification and is shared by the staff UI, the admin UI, and the request endpoint.

### Staff view

A waitlisted staffer sees that the event is fully staffed and a simple **"You're on the waitlist"**. No rank, no count, and no names of other waiting staff.

### Self-removal

A waitlist entry is a `pending` row, and staff can already delete their own pending rows via `DELETE /shifts/requests/:requestId`. This is surfaced as **"Leave waitlist"** in `Mine` (and on the card when waitlisted). Nothing reopens, because a waitlist entry holds no slot.

### Admin view

The admin staffing surface is bench awareness, not a strict queue. The purpose is operational: when a staffer says they cannot or might not make it, the admin can see there is someone in the wings and let them off the hook more easily.

In the `ShiftDrawer` (`client/src/components/adminos/drawers/ShiftDrawer.js`), today's single "Pending requests" list splits into two labeled groups:

- **Actionable**: has an open slot for one of their roles. Approve sets the final `position` from their ranking, defaulting to their top-ranked role that is actually open.
- **Waitlist**: no open slot for any role they picked. Shown oldest-first as a display default (not binding), each row showing the staffer's name and their ranked roles so a freed slot can be matched to the right person. Approving someone here while their role is still full is allowed but flagged as a deliberate over-fill.

The staffing summary on `EventDetailPage` and `EventsDashboard` gains an "N on waitlist" chip. The trigger loop is already closed: when a slot frees via drop, cover, or emergency, admins are notified through the existing `urgent_staffing` channel, prompting them to pull from the waitlist.

---

## Section 4: Notifications and the "fully staffed" semantics shift

Guiding rule: reuse the existing notify paths, stay email-first, add no noise.

- **Actionable request** (open slot): admins get the existing `urgent_staffing` email. Unchanged.
- **Waitlist join** (event full): the staffer gets a low-key "You're on the waitlist for [event]" email so they know it registered. Admins get nothing, because a waitlist join is not actionable and the bench is visible in-app. Routed through the existing notification channel resolver, defaulting to email.
- **Admin approves anyone, including pulling from the waitlist**: rides the existing approve path, so the staffer gets the same confirmation (SMS plus email) as today. No new notification code for promotion.
- **Leaving the waitlist**: silent, like withdrawing a pending request today.

### Semantics shift

Once `positions_needed` includes servers and barbacks, "fully staffed" means every role is filled, not just bartenders. This ripples to the client-facing staffing confirmation (`notifyClientOfStaffingConfirmation` / `confirmStaffingIfFullyStaffed` in `server/utils/lastMinuteStaffingConfirmation.js`). An event with 2 bartenders and 1 server will no longer tell the client "you're fully staffed" the instant the 2 bartenders are approved; it waits for the server too. This is strictly more correct and flows automatically, because that notification already gates on `positions_needed` length (which is now the full roster). The one real edit is copy: the message currently names "your bartender(s)" and now needs to name all assigned staff and their roles.

---

## Section 5: Data model, backfill, and rollout

### Schema change

One additive column:

- `shift_requests.requested_positions` (JSON array of canonical role labels, default `'[]'`), holding the staffer's ranked, willing roles. The existing `position` column remains the single final assigned role, set at approval.

No change to the `shift_requests.status` CHECK. The dev database does not auto-apply schema changes, so the `ALTER TABLE` must be idempotent and applied to dev by hand, in addition to landing in `schema.sql`.

### Backfill

A one-time, idempotent, transactional script re-derives `positions_needed` for all upcoming confirmed events (`event_date >= CURRENT_DATE`), shrink-capped per role so nothing already assigned is disturbed. It supports a dry-run and emits a report of events that gained newly unfilled role slots, so the previously hidden under-staffing (events that paid for a server or barback but have no such slot) becomes a concrete recruiting list. Re-deriving does not re-fire the client "fully staffed" confirmation (that send is one-shot and suppressed once sent), and going from full to not-full fires nothing.

### Rollout order

1. Add the `requested_positions` column (schema plus hand-applied dev ALTER) and normalize legacy `position = 'Server'` to `Banquet Server`.
2. Ship `deriveStaffingRoster` and wire it into `createEventShifts` and `syncShiftsFromProposal`.
3. Ship the classification helper, the request endpoint changes, and the staff UI (tabs, card, ranked request sheet, waitlist state, leave-waitlist).
4. Ship the admin UI (actionable vs waitlist split, waitlist chip, approve-sets-role-from-ranking).
5. Ship the notification additions and the client-confirmation copy change.
6. Run the backfill (dry-run first, review the report, then apply).

---

## Key files

Server:

- `server/utils/eventCreation.js`: `createEventShifts`, `syncShiftsFromProposal`, new `deriveStaffingRoster`.
- `server/utils/pricingEngine.js`: reference for the additive bartender channels and the snapshot headcount recovery pattern (`gratuityBasisFromSnapshot`).
- `server/routes/shifts.js`: request (`POST /shifts/:id/request`), withdraw (`DELETE /shifts/requests/:requestId`), assign and approve (`POST /shifts/:id/assign`, `PUT /shifts/requests/:requestId`).
- `server/routes/shifts.queries.js`: `STAFF_OPEN_SHIFTS_SQL`, `USER_EVENTS_SQL`, plus the per-role approved-count aggregation for fill and classification.
- `server/utils/lastMinuteStaffingConfirmation.js`: fullness check and client confirmation copy.
- `server/db/schema.sql`: `shift_requests.requested_positions`.

Client:

- `client/src/pages/staff/ShiftsPage.js`: tabs, card, request sheet, waitlist state.
- `client/src/components/adminos/drawers/ShiftDrawer.js`: actionable vs waitlist split, approve-sets-role, dropdown label.
- `client/src/components/adminos/shifts.js`: shared parsing and counting helpers (`shiftPositions` no longer hardcodes Bartender).
- `client/src/pages/admin/EventDetailPage.js`, `client/src/pages/admin/EventsDashboard.js`: waitlist chip and per-role fill in the staffing summary.

---

## Edge cases and risks

- Bartender double-count: `num_bartenders` and the `additional-bartender` add-on must be summed, never substituted. Folding one into the other double-staffs.
- Quantity units: staffing add-on quantities are hours, not people. Always divide by the effective hours (`max(event_duration_hours, 4)`), or read counts from `pricing_snapshot.addons[]`.
- Missing or malformed snapshot: fall back to the `proposal_addons` to `service_addons` join, guarding NULL `addon_id` via `addon_name`.
- Approved-state hybrid: every "approved" count must include `AND dropped_at IS NULL`; an emergency-dropped row stays `status = 'approved'` with `dropped_at` set.
- Shrink-cap: lowering a paid role count below its approved assignments must not unassign anyone; cap and log.
- Concurrency: classification is computed at read time, so it cannot desync. The request upsert relies on the existing `UNIQUE(shift_id, user_id)`.

## Testing

- Unit `deriveStaffingRoster`: hosted ratio, num_bartenders override, additional-bartender add-on, banquet servers, barbacks, class package at $0, snapshot-present versus snapshot-missing fallback, NULL `addon_id`.
- Unit classification helper: actionable versus waitlisted across single and multi-role ranked requests, partially staffed events.
- Unit `syncShiftsFromProposal`: per-role shrink-cap.
- Integration: ranked request, waitlist join on a full event, self-removal, admin approve from the waitlist after a drop, client confirmation waiting for all roles.
- Server suites run one at a time against the shared dev database, with `node -r dotenv/config`.
- Client verified with `CI=true react-scripts build`.

## Future work

- Wire the waitlist into the cover/drop broadcast so waiting staff get first dibs when an approved staffer needs out.
- Optional auto-promotion from the waitlist when a slot frees.
- Capability gating of requestable roles from `contractor_profiles.position` plus a bartender-implies-barback-and-server hierarchy.
- Per-role filtering of the admin waitlist view.
