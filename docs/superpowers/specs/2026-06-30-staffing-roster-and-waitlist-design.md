# Staffing roster derivation, waitlist, and event logistics

Date: 2026-06-30
Status: Approved design, reviewed (spec fleet v2), ready for implementation plan

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

The admin assign dropdown currently offers `Server`; both its display label AND its option value change to `Banquet Server`. **Three position-bearing columns must agree:** `shift_requests.position`, the new `requested_positions`, and `contractor_profiles.position` (the cover/drop marketplace matches the last against `positions_needed`). All role comparisons are case-insensitive (payroll already matches `LOWER(position)`), and legacy non-canonical values (`'Server'`, lowercase `'bartender'`/`'barback'`) are normalized. The token `bartender` (any case) is load-bearing for payroll (see Section 4).

---

## Section 1: Staffing roster derivation

### `deriveStaffingRoster(proposal, snapshot)`

A single function returns an ordered array of canonical role labels representing every slot the client paid for. Order is Bartenders, then Banquet Servers, then Barbacks, so `positions_needed` reads cleanly, for example `["Bartender","Bartender","Banquet Server"]`. It takes the proposal row and its `pricing_snapshot` (note: `bar_type` lives on `service_packages`, not on `proposals`, so class detection reads `snapshot.package`, never `proposal.bar_type`).

Per-role headcount:

- **Bartenders** = `proposals.num_bartenders` plus the `additional-bartender` add-on headcount. Two independent, additive channels. `num_bartenders` mirrors `snapshot.staffing.actual` (folds in the hosted 1:100 ratio); the `additional-bartender` add-on is separate and never reflected in `num_bartenders`. Sum them, never substitute.
- **Banquet Servers** = `banquet-server` add-on headcount.
- **Barbacks** = `barback` add-on headcount.

**Headcount recovery is per-channel, because the stored hours differ:**

- `additional-bartender`: stored `quantity = durationHours × headcount` (no minimum-hours floor). Recover `headcount = round(quantity / durationHours)`. Mirrors `gratuityBasisFromSnapshot`.
- `banquet-server` and `barback`: stored `quantity = max(durationHours, 4) × headcount` (both carry `minimum_hours = 4`). Recover `headcount = round(quantity / max(durationHours, 4))`.

A single uniform `max(durationHours, 4)` divisor is wrong for the bartender add-on on any sub-4-hour event (a 2-hour class), so the derivation branches on the add-on slug. Counts are read preferentially from `snapshot.addons[]` (which carry `slug` and the hours-quantity); fallback when the snapshot is missing is a `proposal_addons`-to-`service_addons` join on `addon_id` (note `proposal_addons` has no `slug` column), guarding NULL `addon_id` on legacy rows via `addon_name`, with the same per-slug divisor. Final fallback: `num_bartenders` only.

Notes:

- Class packages zero the bartender charges but the headcount is still real. The derivation reads counts, not prices.
- `deriveStaffingRoster` must never throw on a missing or malformed snapshot (Edge cases: webhook safety). It degrades through the fallbacks.

### `positions_needed` is parsed with a shape-tolerant helper

`positions_needed` exists in **two historical shapes** in production: flat string arrays `["Bartender",...]` AND object arrays `[{position:'bartender',count:N}]`. `server/utils/coverBroadcast.js` already ships a `parsePositionsNeeded` that tolerates both. Every new reader (`deriveStaffingRoster` output stays flat, but `shiftPositions`, the `ShiftsPage` per-role fill, the classification helper, and the admin counters) must go through one shared shape-tolerant parser, not a bare `JSON.parse` + `[]`. Malformed values normalize to `[]`.

### Wiring

`createEventShifts` (replaces `Array(num_bartenders).fill('Bartender')`) and `syncShiftsFromProposal` (replaces the bartender-only reconcile) both route through `deriveStaffingRoster`. `syncShiftsFromProposal` becomes **per-role shrink-capped**: a role's slot count never drops below its already-approved, non-dropped assignments for that role; cap and log `staffing_shrink_capped` per role (the existing code counts approved globally; per-role is new logic with its own test).

### Consumers of `positions_needed` (cross-cutting)

Widening `positions_needed` to mixed roles affects every reader:

- **Cover/drop marketplace (the path Goals pledged not to disturb).** `coverBroadcast.js:148` filters cover candidates by `cp.position = ANY(parsePositionsNeeded(positions_needed))`, and `staffShiftActions.js:566` gates claim-eligibility on the same list. Two consequences: (a) cover broadcasts now reach servers/barbacks too, which is correct but previously impossible (acknowledge as intended), and (b) the compare is against `contractor_profiles.position`, which holds legacy `'Server'` / lowercase values; without canonicalizing it (Section 5) a server stops matching the new `'Banquet Server'` label and silently loses cover access. Make the marketplace comparison canonical + case-insensitive and normalize `contractor_profiles.position`.
- **`client/src/components/adminos/shifts.js`** `shiftPositions` (hardcodes `role:'Bartender'`, discards entries) reads real labels via the shared parser. `pendingCount`/`approvedCount` are row counters but are **global, not per-role**; the admin StaffPills need a per-role breakdown (Section 2) or they mislabel a mixed-role shift's open slots as all Bartender.
- **`client/src/pages/admin/EventsDashboard.js`** create form builds `Array(n).fill('Bartender')`; the upstream data-loss point, must use the roster.
- **`client/src/pages/admin/EventDetailPage.js`** empty-state copy "No bartenders assigned yet" generalizes.
- **Auto-assign stays bartender-scoped.** `autoAssign` approves the top `positions_needed.length − approvedCount` pending requests with no role filter, which would now seat a bartender in a server slot. Scope it: `slotsRemaining` counts only unfilled Bartender slots, only candidates whose `requested_positions` include `Bartender` are eligible, and it writes `position = 'Bartender'`. Servers/barbacks are admin-manual. Role-aware auto-assign is future work.
- **The two admin fullness feeds** (`GET /shifts/unstaffed-upcoming`, the scheduler gate in `server/routes/admin/settings.js`) compare `approved_count < jsonb_array_length(positions_needed)`. As a "not fully staffed" signal this stays correct with mixed roles; no change beyond the auto-assign scoping.
- **No money path reads `positions_needed`.** Confirmed across all five tip-split readers: gratuity dollars come from `pricing_snapshot`; the denominator is `shift_requests` rows with `LOWER(position) = 'bartender'`. Widening is money-safe. The one money-sensitive field is `position` (Section 4).

---

## Section 2: Staff-facing UI

### Tabs (`client/src/pages/staff/ShiftsPage.js`)

`Mine` and `Past` stay. `SUB_TABS` is also the route whitelist and drives `labelFor` and `counts`, so the new "All" tab touches all four. The top two:

- **Available** — events with at least one open slot, computed from approved-active vs `positions_needed` (not the never-set `status='filled'`). Fixes the leak. `ShiftsPage` does not parse `positions_needed` today; the per-role fill is new code.
- **All** — every upcoming event including fully-staffed ones.

### Per-role fill needs a server aggregate

The card's "Bartender 2/2 · Banquet Server 0/1" cannot be computed client-side today: `STAFF_OPEN_SHIFTS_SQL` returns no per-role approved breakdown. Add a per-role approved-active aggregate (a `LATERAL` grouping `shift_requests` by `position` where `status='approved' AND dropped_at IS NULL`, emitted as a JSON object) to the staff feed AND the admin shift queries. The card computes per-role needed from `positions_needed` (shared parser) against this aggregate. The request sheet's gear/supply data is already on the shift row (`equipment_required`, `supply_run_required`) in the projection, so the sheet needs no second fetch.

### Event card

Per-role fill plus the logistics tag (Section 6). Button is event-level: **Request** when any slot is open, **Join waitlist** (with a "Fully staffed" chip) when every role is full.

### Request flow

The sheet that opens on Request / Join waitlist:

- Lists the roles the event needs with their fill status, plus in-sheet loading/empty/error states for the role list.
- The staffer **checks the roles they are willing and able to work** (self-selection).
- If they pick more than one, they **reorder** by preference. The staff portal is phone-first, where HTML5 drag is unreliable, so the reorder uses explicit up/down controls (or an equivalent touch-friendly affordance), not native drag. Zero roles is a blocked submit with inline copy.
- On a transport-required event (Section 6), a warning block and a required acknowledgment checkbox appear; submit is blocked and the button shows a pending state until it is ticked and the request is in flight.
- Submitting **upserts** a `shift_requests` row with ordered `requested_positions` and `status='pending'` (and `transport_acknowledged_at` when applicable). `position` is left NULL until approval (Section 4). The server validates the roles are a non-empty, de-duplicated subset of what the event needs.
- Submit copy reflects the selection: all-full picks read "Join waitlist," else "Request."

Re-submitting upserts on the existing `UNIQUE(shift_id, user_id)` row (change roles/order while pending); a staffer cannot edit roles once approved. Client-side guards mirror the server (non-empty, subset, dedup, acknowledgment gate). `Mine` shows pending/waitlisted + approved-upcoming with a withdraw / leave-waitlist control.

---

## Section 3: Waitlist

### Representation: a computed view, not a new status

Requests keep `pending` / `approved` / `denied`. No enum migration, no background job. A `pending` request is **waitlisted** iff none of its ranked roles has an open slot; else **actionable**. Per role, `remaining[role] = needed[role] − approvedActive[role]` (`approvedActive` = `status='approved' AND dropped_at IS NULL`, grouped by `position`). Actionable if any ranked role has `remaining > 0`; fully staffed when every role's `remaining` is zero. A pending request with empty `requested_positions` (legacy) is treated as "any role." One shared helper computes this for staff UI, admin UI, and the request endpoint.

The moment a slot frees, the same pending row reclassifies from waitlisted to actionable automatically, with nothing to flip. The waitlist promotes itself into the admin's approvable queue.

**On races, precisely:** classification is read-time, so display cannot desync. Role fill is not lock-protected: two concurrent approvals can each read one open slot and both approve, over-filling a role (matches existing auto-assign behavior). This is tolerated and admin-visible, not prevented. For the **Bartender** role specifically an over-fill is a real money event (an extra person in `splitEvenly`), but the exposure is bounded because accrual is `status='completed'`-gated and the admin reconciles the roster before completion. Deliberate admin over-fill requires an explicit confirm, and an over-fill writes a `proposal_activity_log` entry.

### Staff view

A waitlisted staffer sees the event is fully staffed and **"You're on the waitlist."** No rank, no count, no peer names. The existing `/my-requests` rule attaches the team roster only when the viewer's own status is `approved`, so a pending waitlister already gets an empty team; preserve that gate.

### Self-removal

A waitlist entry is a `pending` row; staff already delete their own pending rows via `DELETE /shifts/requests/:requestId`. Surface as **"Leave waitlist."** Nothing reopens.

### Admin view

Bench awareness, not a strict queue. In `ShiftDrawer`, the single "Pending requests" list splits into:

- **Actionable** — has an open slot for one ranked role; Approve resolves and writes the final `position` (Section 4).
- **Waitlist** — no open slot for any ranked role; oldest-first display, each row showing the staffer's name, ranked roles, and the Section 6 logistics flags. Approving while a role is still full is a flagged, confirmed over-fill.

`ShiftDrawer`'s open-slot math becomes **per-role** (today `openCount` is global, so a per-role over-fill mis-renders "fully staffed" and hides a still-needed server slot). `EventDetailPage` and `EventsDashboard` gain an "N on waitlist" chip. When a slot frees via drop/cover/emergency, admins are already notified through `urgent_staffing`.

---

## Section 4: Role resolution at approval, notifications, and the "fully staffed" semantics shift

### Money-critical: the `position` column

Payroll splits the gratuity pool only among `shift_requests` rows where `LOWER(position) = 'bartender'` (`payrollAccrual.js` plus the late-tip / clawback / dispute paths), and `position` has no DB CHECK today. In the new model the request stores ranked `requested_positions` and leaves `position` NULL until approval, so **every approval path must write `position` explicitly**:

- `PUT /shifts/requests/:requestId` (approve) today only flips status and does not touch `position`; it must resolve and write the role.
- `POST /shifts/:id/assign` today defaults `position || 'Bartender'`; the default is removed.
- **`ShiftDrawer` client paths** (`handleApprove`, `handleManualAssign`) today POST `position: req.position || 'Bartender'`; since pending rows now carry NULL `position`, they MUST resolve from `requested_positions` instead, or every approval silently writes `'Bartender'` and seats servers/barbacks into the tip split. This is as load-bearing as the server change.
- Auto-assign writes `position = 'Bartender'` (bartender-scoped).

Resolution rule: the requester's top-ranked role that still has an open slot; on a deliberate over-fill, their top role. When the only open slot is a role the staffer did NOT rank, the admin drawer offers an explicit role picker rather than silently defaulting. **Bartenders resolve to canonical `Bartender`; servers/barbacks never resolve to a bartender label.** The server **rejects** an empty or unknown `position` (never defaults). We add a **case-insensitive** DB CHECK: `position IS NULL OR LOWER(position) IN ('bartender','banquet server','barback')`, applied via `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` (a CHECK cannot be `ADD ... IF NOT EXISTS`), and only after the Section 5 normalization.

### Notifications

Reuse existing paths, email-first, no noise.

- **Actionable request**: admins get the existing `urgent_staffing` email. Unchanged.
- **Waitlist join**: the staffer gets a low-key "You're on the waitlist for [event]" email. Admins get nothing. It fires **only on the transition into waitlisted** (tracked by a sent marker / the row's prior state), so an upsert that merely re-ranks roles sends nothing. Gated by `SEND_NOTIFICATIONS`, degrades on a Resend 5xx exactly like `lastMinuteStaffingConfirmation` (try/catch + Sentry, non-throwing).
- **Admin approves anyone, incl. from the waitlist**: rides the existing approve path, same confirmation (SMS + email). No new promotion code.
- **Leaving the waitlist**: silent.

### Semantics shift

With servers/barbacks in `positions_needed`, "fully staffed" means every role is filled. The client confirmation (`confirmStaffingIfFullyStaffed` / `notifyClientOfStaffingConfirmation`) already gates on `positions_needed` length, so it now waits for the server too. It is one-shot (atomic `last_minute_hold` true-to-false flip) and is not called from any sync/backfill path, so a backfill that flips an event full-to-not-full fires nothing and never demotes the booking. The one edit is copy: `renderBartenderList` selects all approved non-dropped rows but renders a hardcoded "Your bartender" fallback; pass `position` through so a Banquet Server is labeled by role, not "your bartender."

---

## Section 5: Data model, backfill, and rollout

### Schema changes (idempotent)

- `shift_requests.requested_positions` (JSON array, default `'[]'`).
- `shift_requests.transport_acknowledged_at` (TIMESTAMP, nullable).
- `shifts.supply_run_required` (BOOLEAN, default false) — effective value read by the UI; `shifts.supply_run_overridden` (BOOLEAN, default false) — tells `syncShiftsFromProposal` not to recompute it.
- `service_addons.requires_provisioning` (BOOLEAN, default false).
- The case-insensitive `position` CHECK (Section 4).

`position` stays the single resolved role; the `status` CHECK is unchanged. The dev database does not auto-apply schema; each `ALTER`/CHECK is idempotent and hand-applied to dev as well as landing in `schema.sql`.

### Migration of existing rows (order matters)

1. Inventory `SELECT DISTINCT position FROM shift_requests` and `... FROM contractor_profiles` on prod first.
2. Normalize **all** non-canonical `position` values to canonical case (`'Server'`/`'server'` to `Banquet Server`; lowercase `bartender`/`barback` to title case) in **both** `shift_requests.position` and `contractor_profiles.position` (the cover/drop marketplace depends on the latter), and change the dropdown option value.
3. Only then add the case-insensitive `position` CHECK.
4. Backfill `requested_positions = [position]` for `shift_requests` rows with a non-null `position`. The classifier treats empty as "any role," and the request endpoint's non-empty/subset validation applies only to new submits, not to reads of legacy rows.

### Backfill of `positions_needed`

A one-time idempotent script re-derives `positions_needed` for upcoming confirmed events (`event_date >= CURRENT_DATE`), per-role shrink-capped, in a transaction with per-event savepoints so a single mis-derive rolls back. Dry-run prints the per-event planned array (diff vs current) plus a report of events that gained newly-unfilled role slots (a recruiting list). It does not re-fire the client confirmation and does not change booking status.

### Rollout order

1. Schema (columns, CHECK), the migration/normalization above (both position columns), `requested_positions` backfill, hand-applied dev ALTERs.
2. `deriveStaffingRoster` + shape-tolerant parser wired into `createEventShifts` / `syncShiftsFromProposal`; auto-assign scoped to Bartender; the `position`-resolution change to every approval path (server AND `ShiftDrawer`); cover/drop canonical matching.
3. The classification helper, the per-role aggregate in the staff/admin queries, the request endpoint, and the staff UI (tabs, card, ranked sheet, waitlist, leave-waitlist).
4. The admin UI (per-role open math, actionable/waitlist split, waitlist chip, approve-resolves-role + role picker, over-fill confirm + audit log).
5. Section 6 (provisioning flag + seed, supply-run compute/override, equipment+supply edit surface, staff tags + warning + acknowledgment, admin no-transportation flag).
6. Notifications + the `renderBartenderList` copy change.
7. Run the `positions_needed` backfill (dry-run, review, apply).
8. Docs: `ARCHITECTURE.md` (new columns) and `README.md` (per-role roster, waitlist, logistics tags) per the Mandatory Documentation Updates table.

---

## Section 6: Equipment and supplies logistics

### Determining what an event needs

- **Equipment**: `shifts.equipment_required` (exists) is the gear list (portable bar / cooler / table). Non-empty means equipment must be transported.
- **Supplies**: a new per-event supply-run flag. **Computed default = hosted package OR the proposal has any add-on with `requires_provisioning = true`.** `service_addons.requires_provisioning` is seeded true for the consumable/gear add-ons and false for the staffing add-ons (additional bartender, barback, banquet server) and pure-fee add-ons. The seed list is **illustrative, not exhaustive**: at build, derive the complete set by reviewing the full `service_addons` catalog (the illustrative set missed real physical add-ons such as `cups-disposables-only`, `champagne-toast`, `non-alcoholic-beer`, `mocktail-bar`/`pre-batched-mocktail`, `house-made-ginger-beer`, `carbonated-cocktails`, the specialty-spirit siblings, `class-tool-kit-purchase`, and the class `*-supplies` rows). Use slug-exact `WHERE slug IN (...)`. `createEventShifts` / `syncShiftsFromProposal` compute the default into `shifts.supply_run_required`; the admin supply-run toggle sets it and flips `supply_run_overridden` so sync never clobbers a manual choice. (Known gap: a future consumable add-on added without `requires_provisioning=true` will not trigger a supply run; the admin add-on surface should expose the flag.)
- **Bar Kit Only** (derived on read) = `equipment_required` empty AND `supply_run_required` false. Otherwise transport-required.

Staff-facing copy stays binary: "this event needs supplies, be prepared for a Pilsen warehouse pickup and/or a shopping run."

### Staff surfacing

- **Event card**: a prominent tag, green **"Bar Kit Only"** or a warning chip naming **"Equipment"** and/or **"Supplies."**
- **Request sheet** (transport-required only): a warning block naming the gear and/or supply run, the unpaid Pilsen pickup/drop-off expectation, and a **required acknowledgment checkbox** ("I can transport equipment and supplies for this event, including pickup and drop-off at the Pilsen storage unit"). Submit blocked until ticked; ticking records `transport_acknowledged_at`. Bar Kit Only events skip it. If an event's logistics change to transport-required after a staffer acknowledged (or `equipment_required` changes materially), the acknowledgment is re-required; if it flips to Bar Kit Only, a stale acknowledgment is ignored so the admin "ticked box but no vehicle" flag never shows on a Bar Kit event.

### Admin surfacing

- An edit surface for `equipment_required` and the supply-run toggle on an existing event (today the equipment picker is create-only). It routes through an admin-guarded endpoint (`requireStaffing`), validates `equipment_required` against the known token allow-list (`portable_bar` / `cooler` / `table_with_spandex`, matching the autoAssign scorer keys) with a length bound, and has explicit save/validation/loading states. Editing `equipment_required` does not touch the supply-run value; only the supply toggle sets `supply_run_overridden`.
- A **"no transportation on file"** flag next to each requester in the `ShiftDrawer` and waitlist, read from `contractor_profiles.reliable_transportation`. The value is free-text and inconsistent across writers (`Yes`/`No`/`Maybe`, `Sometimes`, lowercase, NULL/`''`), so map **case-insensitively**: `no` / NULL / `''` render the red "no transportation on file" flag; `maybe` / `sometimes` render a softer "transportation uncertain" flag; `yes` renders nothing. `reliable_transportation` is admin-only and never joined into the staff-facing feed.

### Auto-assign

Unchanged. It already guarantees equipment coverage among assigned staff (owns the item or `equipment_will_pickup`). Supply-run is informational + the admin flag this pass; not in the scorer.

---

## Key files

Server:

- `server/utils/eventCreation.js`: `createEventShifts`, `syncShiftsFromProposal`, new `deriveStaffingRoster`, supply-run default compute.
- `server/utils/pricingEngine.js`: reference for the additive bartender channels and per-slug recovery (`gratuityBasisFromSnapshot`).
- `server/utils/coverBroadcast.js`, `server/routes/staffShiftActions.js`: the cover/drop marketplace; canonical + case-insensitive position matching; the shared `parsePositionsNeeded`.
- `server/utils/autoAssign.js`: scope to Bartender; write `position = 'Bartender'`.
- `server/utils/payrollAccrual.js` (+ late-tip/clawback/dispute): the `LOWER(position)='bartender'` tip-split dependency the resolution protects.
- `server/routes/shifts.js`: request, withdraw/leave-waitlist, assign + approve with explicit `position` resolution; `GET /shifts/unstaffed-upcoming`.
- `server/routes/shifts.queries.js`: `STAFF_OPEN_SHIFTS_SQL`, `USER_EVENTS_SQL`, the new per-role approved-count aggregate; narrow `s.*` to drop `client_email`/`client_phone`; preserve the team-only-when-approved gate.
- `server/routes/admin/settings.js`: the scheduler gate (no change beyond Section 1).
- `server/utils/lastMinuteStaffingConfirmation.js`: fullness check, `renderBartenderList` role-per-row copy.
- `server/db/schema.sql`: new columns, the case-insensitive `position` CHECK, the `requires_provisioning` seed.

Client:

- `client/src/pages/staff/ShiftsPage.js`: tabs (+ `SUB_TABS`/`labelFor`/`counts`), card, request sheet, touch-friendly reorder, waitlist state, logistics tag + warning + acknowledgment.
- `client/src/components/adminos/drawers/ShiftDrawer.js`: per-role open math, actionable/waitlist split, **approve resolves `position` from `requested_positions`** (not `|| 'Bartender'`), role picker, over-fill confirm, dropdown value `Banquet Server`, no-transportation flag.
- `client/src/components/adminos/shifts.js`: `shiftPositions` + counters via the shared shape-tolerant parser, per-role aware.
- `client/src/pages/admin/EventDetailPage.js`, `client/src/pages/admin/EventsDashboard.js`: waitlist chip, per-role fill, roster-based create form, equipment+supply edit surface.

---

## Edge cases and risks

- **Bartender double-count**: sum `num_bartenders` + `additional-bartender`, never substitute.
- **Per-slug divisor**: `additional-bartender` ÷ `durationHours`; `banquet-server`/`barback` ÷ `max(durationHours, 4)`; `Math.round` to an integer.
- **Two `positions_needed` shapes**: all readers use the shared shape-tolerant parser.
- **The `position` money seam**: every approval path (server AND `ShiftDrawer`) writes an explicit validated role; bartenders resolve to a bartender label, servers/barbacks never do; server rejects empty/unknown.
- **CHECK ordering**: normalize both position columns first, then add the case-insensitive CHECK via DROP+ADD.
- **Cover/drop**: `contractor_profiles.position` canonicalized so servers keep cover access.
- **Approved-state hybrid**: every "approved" count includes `AND dropped_at IS NULL`.
- **Per-role shrink-cap**: never unassign; cap and log per role (new logic, own test).
- **Over-fill**: tolerated/bounded; Bartender over-fill is a real (but completion-gated) money event; confirm + audit-log it.
- **Webhook safety**: `createEventShifts` runs from the Stripe webhook (non-blocking); `deriveStaffingRoster` + supply-run compute must never throw on a missing/malformed snapshot.
- **Manually-created $0 events**: no snapshot/addons; roster yields `num_bartenders`-only, supply-run false (Bar Kit Only), admin-overridable.
- **Acknowledgment lifecycle**: re-required when logistics escalate; ignored when an event becomes Bar Kit Only.
- **PII**: staff feed drops client contact info and keeps the peer-name gate; `reliable_transportation` is admin-only.

## Observability

Log: the roster-derivation fallback path taken (snapshot vs join vs num_bartenders-only), role resolution at approval, the supply-run override, and the deliberate over-fill (a `proposal_activity_log` entry, since it changes the tip-split denominator). `staffing_shrink_capped` stays.

## Testing

- Unit `deriveStaffingRoster`: hosted ratio, override, additional-bartender, servers, barbacks, class $0, snapshot-missing fallback, NULL `addon_id`, sub-4-hour event, both `positions_needed` shapes.
- Unit classification: actionable vs waitlisted across single/multi-role and empty `requested_positions`.
- Unit role resolution: bartender to a bartender label, server/barback never to one, over-fill default, unranked-role admin pick.
- Unit `syncShiftsFromProposal`: per-role shrink-cap. Unit supply-run default: hosted, provisioning add-on present/absent, override survives sync.
- Integration: ranked request, transport acknowledgment gate (and re-require on escalation), waitlist join + dedup email, self-removal, admin approve from the waitlist after a drop, cover broadcast still reaches a server, client confirmation waiting for all roles, auto-assign filling only bartender slots.
- Server suites one at a time against the shared dev DB with `node -r dotenv/config`. Client verified with `CI=true react-scripts build`.

## Future work

- Wire the waitlist into the cover/drop broadcast (first dibs on a freed slot).
- Auto-promotion from the waitlist.
- Role-aware auto-assign (servers/barbacks, not just bartender).
- Fold supply-run into the auto-assign scorer.
- Hard prevention of over-fill (`FOR UPDATE` / unique-slot).
- Capability gating of requestable roles from `contractor_profiles.position` plus a bartender-implies-barback-and-server hierarchy.
- Expose `requires_provisioning` on the add-on admin surface.
