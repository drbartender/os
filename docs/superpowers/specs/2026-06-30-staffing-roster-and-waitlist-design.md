# Staffing roster derivation, waitlist, and event logistics

Date: 2026-06-30
Status: Approved design, ready for implementation plan

## Problem

Three related gaps in how events get staffed.

**1. Shifts are only created for bartenders.** Today an event gets exactly one `shifts` row, and its slot count (`positions_needed`, a JSON array) is built from `proposals.num_bartenders` alone, filled entirely with the string `"Bartender"`. Banquet servers and barbacks are priced and paid for as `service_addons` (category `staffing`), but they never become shift slots. Worse, bartenders added through the `additional-bartender` add-on path (rather than the `num_bartenders` stepper) are also dropped, because the two channels are additive and only the first is read. Result: a client can pay for 2 bartenders and a banquet server and the system creates 2 bartender slots and zero server slots. The requirement: if the event shows and the client paid for 2 bartenders and a banquet server, there must be 2 bartender slots and 1 server slot, regardless of how or when those roles were added to the booking.

**2. No "staffed" signal and no waitlist.** The schema has a `filled` status for shifts, but no code path ever sets it, so a fully staffed event never leaves `status = 'open'` and keeps appearing in the staff "Available" list with a live Request button. There is no way for staff to see that an event is already staffed, no way to join a waitlist behind a full event, and no admin view of who is waiting in the wings.

**3. Equipment and supply logistics are invisible to staff.** Some events require gear (bars, coolers) and most require a supply run (ice, mixers, glassware, syrups, the smoke gun, and so on) that a staffer must pick up at the Pilsen storage unit or shop for. Staff without transportation are requesting hosted events they cannot actually service. The data to reason about this mostly exists (`shifts.equipment_required`, `contractor_profiles.reliable_transportation`, equipment-ownership flags, `equipment_will_pickup`) but is never surfaced to staff at the moment they browse or request a shift.

## Goals

- One source of truth that derives the full per-role staffing roster for a proposal and feeds every path that builds shift slots.
- Staff can see staffed events, request open roles (ranked by preference), join a waitlist when an event is full, and remove themselves from that waitlist.
- Admin can see the waitlist (who is in the wings, and for which roles) and pull from it.
- Staff see, prominently, whether an event needs transportation for equipment or supplies, and must acknowledge that capability before requesting. Events that need neither are tagged "Bar Kit Only."
- Reuse the existing assignment and notification paths. Do not disturb the working cover/drop marketplace, the gratuity/payroll money paths, or the Stripe webhook.

## Non-goals (deferred, see Future work)

- Auto-promotion from the waitlist when a slot opens. Promotion is manual this pass.
- Merging the waitlist into the cover/drop broadcast pool.
- Hard capability gating of which roles a staffer may request (we trust self-selection plus admin approval).
- Showing waitlisted staff their position or the names of other waiting staff.
- Role-aware auto-assign. Auto-assign stays bartender-scoped this pass (see Section 1).
- Folding the supply-run requirement into the auto-assign scorer. It is informational plus an admin flag this pass.

## Vocabulary

Canonical role labels, used uniformly across `positions_needed`, `requested_positions`, the resolved `position` column, and the admin assign dropdown:

- `Bartender`
- `Banquet Server`
- `Barback`

The admin assign dropdown currently offers `Server`; both its display label AND its option value change to `Banquet Server`. Any legacy `shift_requests.position = 'Server'` rows are normalized to `Banquet Server`. The exact string `Bartender` is load-bearing for payroll (see Section 4).

---

## Section 1: Staffing roster derivation

### `deriveStaffingRoster(proposal, snapshot)`

A single function returns an ordered array of canonical role labels representing every slot the client paid for. Order is Bartenders, then Banquet Servers, then Barbacks, so `positions_needed` reads cleanly, for example `["Bartender","Bartender","Banquet Server"]`. It takes the proposal row and its `pricing_snapshot` (note: `bar_type` lives on `service_packages`, not on `proposals`, so class detection reads `snapshot.package`, never `proposal.bar_type`).

Per-role headcount:

- **Bartenders** = `proposals.num_bartenders` plus the `additional-bartender` add-on headcount. These are two independent, additive channels. `num_bartenders` mirrors `snapshot.staffing.actual` and already folds in the hosted-package 1:100 ratio. The `additional-bartender` add-on is separate and is never reflected in `num_bartenders`. They must be summed and never substituted (the pricing engine sums them in `pricingEngine.js`).
- **Banquet Servers** = `banquet-server` add-on headcount.
- **Barbacks** = `barback` add-on headcount.

**Headcount recovery is per-channel, because the stored hours differ.** Staffing add-on quantities are stored in hours, not people, and the divisor is not uniform:

- `additional-bartender`: stored `quantity = durationHours × headcount` with no minimum-hours floor. Recover `headcount = round(quantity / durationHours)`. This mirrors `gratuityBasisFromSnapshot` exactly.
- `banquet-server` and `barback`: stored `quantity = max(durationHours, 4) × headcount` (both carry `minimum_hours = 4`). Recover `headcount = round(quantity / max(durationHours, 4))`.

A single uniform `max(durationHours, 4)` divisor is wrong for the bartender add-on on any sub-4-hour event (for example a 2-hour class), so the derivation branches on the add-on slug, not one rule. Counts are read preferentially from `snapshot.addons[]` (which carry `slug` and the hours-quantity); the fallback when the snapshot is missing is a `proposal_addons` to `service_addons` join on `addon_id` (note `proposal_addons` has no `slug` column), guarding NULL `addon_id` on legacy rows by matching `addon_name`, with the same per-slug divisor. Final fallback: `num_bartenders` only.

Notes:

- Class packages zero the bartender charges but the headcount is still real. The derivation reads counts, not prices, so this is handled.
- Parse `positions_needed` with `JSON.parse` plus a fallback to `[]`; never call `Array.isArray` on the raw string. Normalize malformed values to `[]`.
- `deriveStaffingRoster` must never throw on a missing or malformed snapshot (see Edge cases: webhook safety). It degrades through the fallbacks above.

### Wiring

Both slot-building paths route through `deriveStaffingRoster`:

- `createEventShifts` (in `server/utils/eventCreation.js`) replaces the current `Array(num_bartenders).fill('Bartender')`.
- `syncShiftsFromProposal` (runs on every proposal edit) replaces the bartender-only reconcile.

`syncShiftsFromProposal` becomes **per-role shrink-capped**: a role's slot count never drops below the number of already-approved, non-dropped assignments for that role. When the desired count for a role is below its approved count, keep the approved count and log `staffing_shrink_capped` to `proposal_activity_log`, the same as the bartender-only logic does today, but now per role. Note the existing shrink-cap counts approved rows globally; the per-role version is new logic that needs its own test.

### Consumers of `positions_needed` (cross-cutting)

Widening `positions_needed` to mixed roles affects every reader. Enumerated:

- **`client/src/components/adminos/shifts.js`** `shiftPositions` (currently hardcodes `role: 'Bartender'` and discards the array entries) must read the real labels. `parsePositionsCount` / `approvedCount` / `pendingCount` are already role-agnostic length/row counters and stay.
- **`client/src/pages/admin/EventsDashboard.js`** create form builds `Array(n).fill('Bartender')` at write time; this is the upstream data-loss point and must use the roster.
- **`client/src/pages/admin/EventDetailPage.js`** empty-state copy "No bartenders assigned yet" generalizes.
- **Auto-assign stays bartender-scoped.** `autoAssign` (`server/utils/autoAssign.js`) ranks pending requests and approves the top `slotsRemaining = positions_needed.length − approvedCount` with no role filter, which would now seat a bartender in a server slot. To keep it correct without a rewrite, auto-assign is scoped to the Bartender role: `slotsRemaining` counts only unfilled Bartender slots, only candidates whose `requested_positions` include `Bartender` are eligible, and it writes `position = 'Bartender'`. Servers and barbacks are filled manually by admin. Role-aware auto-assign is future work.
- **The two admin fullness feeds** (`GET /shifts/unstaffed-upcoming` in `shifts.js`, and the auto-assign scheduler gate in `server/routes/admin/settings.js`) compare `approved_count < jsonb_array_length(positions_needed)`. As a "not fully staffed" signal this stays correct with mixed roles; no change needed beyond the auto-assign scoping above.
- **No money path reads `positions_needed`.** Confirmed: gratuity dollars come from `pricing_snapshot`; the payroll tip-split denominator is the count of `shift_requests` rows with `position = 'bartender'`. Widening `positions_needed` is money-safe. The one money-sensitive field is `position` (see Section 4).

One cleanup: canonical role strings. The add-ons are named "Banquet Server" / "Barback," and the admin assign dropdown's option value changes from `Server` to `Banquet Server`, so the roster, the request, and the assign path all speak the same vocabulary.

---

## Section 2: Staff-facing UI

### Tabs (`client/src/pages/staff/ShiftsPage.js`)

`Mine` and `Past` stay. The top of the list gains an "All" tab; `Available` is corrected:

- **Available** — events with at least one open slot. Fullness is computed from approved-active assignments versus `positions_needed`, not from the never-set `status = 'filled'`. This fixes the leak where staffed events lingered here. (`ShiftsPage.js` does not parse `positions_needed` today; the per-role fill computation is new code in that file.)
- **All** — every upcoming event, including fully-staffed ones. This is the "show staffed events too" surface.

### Event card

Shows per-role fill, for example `Bartender 2/2 · Banquet Server 0/1`, plus the logistics tag (Section 6). The action button is context-aware at the event level:

- Open slots: **Request**
- Fully staffed (every role full): **Join waitlist**, with a "Fully staffed" chip.

### Request flow

The sheet that opens on Request or Join waitlist:

- Lists the roles the event needs with their fill status.
- The staffer **checks the roles they are willing and able to work** (self-selection; the system does not filter by stored qualification this pass).
- If they pick more than one role, they **drag to rank** by preference. Picking zero roles is a blocked submit with inline copy.
- On a transport-required event (Section 6), a warning block and a required acknowledgment checkbox appear; submit is blocked until it is ticked.
- Submitting **upserts** a `shift_requests` row with the ordered `requested_positions` and `status = 'pending'` (and `transport_acknowledged_at` when applicable). `position` is left unresolved until approval (see Section 4). The server validates the picked roles are a non-empty, de-duplicated subset of what the event needs.
- The submit copy reflects the staffer's actual selection: if every role they picked is full, it reads "Join waitlist"; otherwise "Request."

The sheet has explicit loading, empty (no roles needed / event gone), and error-with-retry states. Re-submitting upserts on the existing `UNIQUE(shift_id, user_id)` row, letting a staffer change willing roles or ranking while still pending; a staffer cannot edit roles once approved (the request UI is replaced by their assigned-shift view).

The `Mine` tab shows their pending/waitlisted requests and approved upcoming shifts, each with the role(s) and a withdraw / leave-waitlist control (Section 3).

---

## Section 3: Waitlist

### Representation: a computed view, not a new status

Requests keep the existing statuses `pending`, `approved`, `denied`. There is no enum migration and no background reconciliation job.

A `pending` request is classified **waitlisted** if and only if none of its ranked roles currently has an open slot; otherwise it is **actionable**. Per role, `remaining[role] = needed[role] − approvedActive[role]`, where `approvedActive` counts `status = 'approved' AND dropped_at IS NULL` grouped by `position`. A request is actionable if any role in its `requested_positions` has `remaining > 0`. The event is fully staffed when every role's `remaining` is zero.

The consequence: the moment a slot frees (a drop, an admin removal, or the client adding capacity), the same pending row reclassifies from waitlisted to actionable automatically, with nothing to flip. The waitlist promotes itself into the admin's approvable queue; admin just approves. A single canonical helper computes this classification, shared by the staff UI, the admin UI, and the request endpoint.

**On races, precisely:** classification is computed at read time, so the displayed waitlisted/actionable state cannot desync. Role fill itself is not lock-protected: two concurrent approvals can each read one open slot and both approve, over-filling a role. This matches the existing auto-assign behavior and is bounded and admin-visible (over-fill is tolerated, see the admin view below), not prevented. Hard prevention would be a `FOR UPDATE` / unique-slot change and is out of scope.

### Staff view

A waitlisted staffer sees that the event is fully staffed and a simple **"You're on the waitlist."** No rank, no count, no names of other waiting staff. (The existing `/my-requests` rule attaches the team roster only when the viewer's own status is `approved`, so a pending waitlister already gets an empty team; preserve that gate.)

### Self-removal

A waitlist entry is a `pending` row, and staff can already delete their own pending rows via `DELETE /shifts/requests/:requestId`. Surfaced as **"Leave waitlist"** in `Mine` (and on the card when waitlisted). Nothing reopens, since a waitlist entry holds no slot.

### Admin view

The admin staffing surface is bench awareness, not a strict queue: when a staffer says they cannot or might not make it, the admin sees there is someone in the wings and can let them off the hook more easily.

In the `ShiftDrawer`, today's single "Pending requests" list splits into two labeled groups:

- **Actionable** — has an open slot for one of their roles. Approve resolves and writes the final `position` (Section 4), defaulting to their top-ranked role that is actually open.
- **Waitlist** — no open slot for any role they picked; ordered oldest-first as a display default (not binding), each row showing the staffer's name, their ranked roles, and the logistics flags from Section 6 (no-transportation-on-file, transport acknowledged). Approving here while the role is still full is allowed but flagged as a deliberate over-fill.

The staffing summary on `EventDetailPage` and `EventsDashboard` gains an "N on waitlist" chip. When a slot frees via drop/cover/emergency, admins are already notified through the existing `urgent_staffing` channel, prompting them to pull from the waitlist.

---

## Section 4: Role resolution at approval, notifications, and the "fully staffed" semantics shift

### Money-critical: the `position` column

Payroll splits the gratuity pool only among `shift_requests` rows where `LOWER(position) = 'bartender'` (`payrollAccrual.js`, and the late-tip / clawback / dispute paths), and `position` has no DB CHECK. In the new model the request row stores ranked `requested_positions` and leaves `position` unresolved until approval. Therefore **every approval path must write `position` explicitly** to the resolved canonical role:

- `PUT /shifts/requests/:requestId` (approve) today only flips status and does not touch `position`; it changes to resolve and write the role.
- `POST /shifts/:id/assign` today defaults `position || 'Bartender'` (`shifts.js`); the default is removed in favor of an explicit, validated role.
- Auto-assign writes `position = 'Bartender'` (it is bartender-scoped, Section 1).

Resolution rule: the requester's top-ranked role that still has an open slot; on a deliberate admin over-fill, their top-ranked role. **Bartender approvals resolve to exactly `Bartender`** so the tip split includes them; **server and barback approvals must never resolve to `Bartender`.** Server-side validation rejects an empty or unknown `position`, and we add a DB CHECK constraining `position` to the canonical labels (NULL allowed for unresolved pending rows).

### Notifications

Guiding rule: reuse the existing notify paths, stay email-first, add no noise.

- **Actionable request** (open slot): admins get the existing `urgent_staffing` email. Unchanged.
- **Waitlist join** (event full): the staffer gets a low-key "You're on the waitlist for [event]" email so they know it registered. Admins get nothing. Routed through the existing notification channel resolver, defaulting to email. Deduped so re-submitting (editing roles) does not re-send, gated by `SEND_NOTIFICATIONS`, and degrading gracefully on a Resend 5xx.
- **Admin approves anyone, including pulling from the waitlist**: rides the existing approve path, so the staffer gets the same confirmation (SMS plus email) as today. No new notification code for promotion.
- **Leaving the waitlist**: silent, like withdrawing a pending request today.

### Semantics shift

Once `positions_needed` includes servers and barbacks, "fully staffed" means every role is filled, not just bartenders. This ripples to the client-facing staffing confirmation (`notifyClientOfStaffingConfirmation` / `confirmStaffingIfFullyStaffed` in `server/utils/lastMinuteStaffingConfirmation.js`). An event with 2 bartenders and 1 server will no longer tell the client "you're fully staffed" the instant the 2 bartenders are approved; it waits for the server too. This flows automatically because that confirmation already gates on `positions_needed` length, and it is one-shot (the atomic `last_minute_hold` true-to-false flip), so a backfill that flips an event from full to not-full fires nothing and does not demote the booking.

The one real edit is copy: `renderBartenderList` selects all approved non-dropped rows but renders them with a hardcoded "Your bartender" fallback. The copy must carry the role per row so a Banquet Server is not announced as "your bartender"; pass `position` through and label each by role.

---

## Section 5: Data model, backfill, and rollout

### Schema changes (all idempotent: `ADD COLUMN IF NOT EXISTS`)

- `shift_requests.requested_positions` (JSON array of canonical role labels, default `'[]'`), the staffer's ranked willing roles.
- `shift_requests.transport_acknowledged_at` (TIMESTAMP, nullable), set when a staffer acknowledges transport capability on a transport-required event.
- `shifts.supply_run_required` (BOOLEAN, default false) and `shifts.supply_run_overridden` (BOOLEAN, default false). The first is the effective value read by the UI; the second tells `syncShiftsFromProposal` not to recompute it (Section 6).
- `service_addons.requires_provisioning` (BOOLEAN, default false), seeded true for the consumable/gear add-ons (Section 6).
- A DB CHECK on `shift_requests.position` constraining it to the canonical labels, NULL allowed.

The `position` column stays as the single resolved assigned role. The `shift_requests.status` CHECK is unchanged. The dev database does not auto-apply schema changes, so each `ALTER`/`CHECK` must be idempotent and applied to dev by hand, in addition to landing in `schema.sql`.

### Migration of existing rows

- Normalize legacy `position = 'Server'` to `Banquet Server` (and change the dropdown option value, not just its label, so new rows do not re-dirty).
- Backfill `requested_positions = [position]` for existing rows that have a non-null `position`, so the classifier never sees an empty willing-list. The classifier also treats an empty `requested_positions` as "any role" for safety.

### Backfill of `positions_needed`

A one-time, idempotent script re-derives `positions_needed` for all upcoming confirmed events (`event_date >= CURRENT_DATE`), per-role shrink-capped so nothing already assigned is disturbed. It runs in a transaction with per-event savepoints so a single mis-derive rolls back cleanly. Dry-run prints the planned `positions_needed` per event plus a report of events that gained newly-unfilled role slots, so the previously hidden under-staffing becomes a concrete recruiting list. Re-deriving does not re-fire the client confirmation (one-shot, suppressed once sent) and does not change booking status.

### Rollout order

1. Schema (columns, CHECK, hand-applied dev ALTERs), legacy `position` normalization, and `requested_positions` backfill of old rows.
2. `deriveStaffingRoster` wired into `createEventShifts` and `syncShiftsFromProposal`; auto-assign scoped to Bartender; the `position`-resolution change to every approval path.
3. The classification helper, the request endpoint changes, and the staff UI (tabs, card, ranked request sheet, waitlist state, leave-waitlist).
4. The admin UI (actionable vs waitlist split, waitlist chip, approve-resolves-role).
5. Section 6 (provisioning flag + seed, supply-run compute/override, equipment+supply edit surface, staff tags + warning + acknowledgment, admin no-transportation flag).
6. The notification additions and the `renderBartenderList` copy change.
7. Run the `positions_needed` backfill (dry-run first, review the report, then apply).
8. Docs: update `ARCHITECTURE.md` (schema: the new columns) and `README.md` (Key Features: per-role roster, waitlist, logistics tags) per the Mandatory Documentation Updates table.

---

## Section 6: Equipment and supplies logistics

### Determining what an event needs

- **Equipment**: `shifts.equipment_required` (exists) is the gear list (portable bar / cooler / table). Non-empty means equipment must be transported (a staffer brings their own or picks up at Pilsen).
- **Supplies**: a new per-event supply-run flag. The **computed default is hosted package OR the proposal has any add-on with `requires_provisioning = true`**. The new `service_addons.requires_provisioning` flag is seeded true for the consumable/gear add-ons (ice delivery, bottled water, signature/full mixers, garnish package, soft-drink add-on, zero-proof spirits, flavor blaster, handcrafted syrups, real-glassware / coupe upgrades, smoked cocktail kit, specialty mezcal, class tool-kit rental) and false for the staffing add-ons (additional bartender, barback, banquet server). `createEventShifts` and `syncShiftsFromProposal` compute the default into `shifts.supply_run_required`; an admin toggle sets it and flips `supply_run_overridden` so the sync never clobbers a manual choice.
- **Bar Kit Only** (derived, on read) = `equipment_required` empty AND `supply_run_required` false. Otherwise the event is transport-required.

The staff-facing copy stays binary and non-specific about warehouse-vs-order: "this event needs supplies, be prepared for a Pilsen warehouse pickup and/or a shopping run." Admin knows the specifics; staff need readiness for either.

### Staff surfacing

- **Event card** (Available / All): a prominent tag, green **"Bar Kit Only"** when it is public-transit-safe, or a warning chip naming what is needed (**"Equipment"** and/or **"Supplies"**) otherwise.
- **Request sheet** (transport-required events only): a warning block that names the gear and/or the supply run, states the unpaid Pilsen pickup/drop-off expectation, and a **required acknowledgment checkbox**: "I can transport equipment and supplies for this event, including pickup and drop-off at the Pilsen storage unit." Submit is blocked until it is ticked; ticking records `shift_requests.transport_acknowledged_at`. Bar Kit Only events skip the warning and checkbox.

### Admin surfacing

- An edit surface for `equipment_required` and the supply-run toggle on an existing event (today the equipment picker is create-only on `EventsDashboard`). This is where `supply_run_overridden` gets set.
- A **"no transportation on file"** flag next to each requester in the `ShiftDrawer` (and the waitlist), read from `contractor_profiles.reliable_transportation`. Paired with the acknowledgment, admin sees anyone who ticked the box but has no vehicle on file before approving.

### Auto-assign

Unchanged. It already guarantees equipment coverage among assigned staff (the candidate owns the item or has `equipment_will_pickup`). The supply-run requirement is informational plus the admin flag in this pass; it is not added to the scorer.

---

## Key files

Server:

- `server/utils/eventCreation.js`: `createEventShifts`, `syncShiftsFromProposal`, new `deriveStaffingRoster`, supply-run default compute.
- `server/utils/pricingEngine.js`: reference for the additive bartender channels and the per-slug headcount recovery (`gratuityBasisFromSnapshot`).
- `server/utils/autoAssign.js`: scope to Bartender role; write `position = 'Bartender'`.
- `server/utils/payrollAccrual.js` (and late-tip/clawback/dispute): the `position = 'bartender'` tip-split dependency the approval resolution must protect.
- `server/routes/shifts.js`: request (`POST /shifts/:id/request`), withdraw/leave-waitlist (`DELETE /shifts/requests/:requestId`), assign and approve (`POST /shifts/:id/assign`, `PUT /shifts/requests/:requestId`) with explicit `position` resolution; `GET /shifts/unstaffed-upcoming`.
- `server/routes/shifts.queries.js`: `STAFF_OPEN_SHIFTS_SQL`, `USER_EVENTS_SQL`, the per-role approved-count aggregation; narrow the `s.*` projection to drop `client_email` / `client_phone` (staff never need client contact info), preserve the team-only-when-approved gate.
- `server/routes/admin/settings.js`: the auto-assign scheduler gate (no change beyond Section 1).
- `server/utils/lastMinuteStaffingConfirmation.js`: fullness check and `renderBartenderList` copy (role per row).
- `server/db/schema.sql`: the new columns, the `position` CHECK, the `requires_provisioning` seed.

Client:

- `client/src/pages/staff/ShiftsPage.js`: tabs, card, request sheet, ranked role picker, waitlist state, logistics tag + warning + acknowledgment.
- `client/src/components/adminos/drawers/ShiftDrawer.js`: actionable vs waitlist split, approve-resolves-role, dropdown value `Banquet Server`, no-transportation flag.
- `client/src/components/adminos/shifts.js`: `shiftPositions` reads real labels.
- `client/src/pages/admin/EventDetailPage.js`, `client/src/pages/admin/EventsDashboard.js`: waitlist chip, per-role fill, roster-based create form, equipment+supply edit surface.

---

## Edge cases and risks

- **Bartender double-count**: `num_bartenders` and the `additional-bartender` add-on must be summed, never substituted.
- **Per-slug divisor**: `additional-bartender` divides by `durationHours`; `banquet-server` / `barback` divide by `max(durationHours, 4)`. A uniform divisor mis-counts on sub-4-hour events. Round to an integer.
- **The `position` money seam**: every approval path writes an explicit, validated role; bartenders resolve to exactly `Bartender`, servers/barbacks never do (Section 4).
- **Approved-state hybrid**: every "approved" count includes `AND dropped_at IS NULL`.
- **Per-role shrink-cap**: lowering a paid role count below its approved assignments must not unassign anyone; cap and log. New per-role logic, own test.
- **Over-fill races**: tolerated and bounded, not prevented (Section 3).
- **Webhook safety**: `createEventShifts` runs from the Stripe webhook (non-blocking, `stripeWebhook.js`). `deriveStaffingRoster` must never throw on a missing/malformed `pricing_snapshot`; it degrades through the `proposal_addons` join, then `num_bartenders`-only, so payment confirmation can never break.
- **Manually-created events**: `POST /shifts` builds a backing proposal (`total_price 0`, no add-ons, no snapshot). `deriveStaffingRoster` yields `num_bartenders`-only and supply-run false (Bar Kit Only), admin-overridable.
- **Old request rows**: `requested_positions` backfilled from `position`; classifier treats empty as "any role."
- **PII**: the staff query narrows to drop client contact info and keeps the peer-name gate.

## Testing

- Unit `deriveStaffingRoster`: hosted ratio, `num_bartenders` override, additional-bartender add-on, banquet servers, barbacks, class package at $0, snapshot-present vs snapshot-missing fallback, NULL `addon_id`, sub-4-hour event (per-slug divisor).
- Unit classification helper: actionable vs waitlisted across single and multi-role ranked requests, partially staffed events, empty `requested_positions`.
- Unit role resolution at approval: bartender resolves to exactly `Bartender`; server/barback never resolve to `Bartender`; over-fill default.
- Unit `syncShiftsFromProposal`: per-role shrink-cap.
- Unit supply-run default: hosted, provisioning add-on present/absent, override sticks across sync.
- Integration: ranked request, transport acknowledgment gate, waitlist join, self-removal, admin approve from the waitlist after a drop, client confirmation waiting for all roles, auto-assign filling only bartender slots.
- Server suites run one at a time against the shared dev database, with `node -r dotenv/config`.
- Client verified with `CI=true react-scripts build`.

## Future work

- Wire the waitlist into the cover/drop broadcast so waiting staff get first dibs when an approved staffer needs out.
- Optional auto-promotion from the waitlist when a slot frees.
- Role-aware auto-assign (fill server/barback slots, not just bartender).
- Fold the supply-run requirement into the auto-assign scorer.
- Capability gating of requestable roles from `contractor_profiles.position` plus a bartender-implies-barback-and-server hierarchy.
- Per-role filtering of the admin waitlist view.
