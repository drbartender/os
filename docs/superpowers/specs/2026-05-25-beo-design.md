# BEO (Banquet Event Order) Portal and Finalize Flow

**Date:** 2026-05-25
**Status:** Design, awaiting review
**Type:** New surface + schema additions + new scheduled-message handler.

## 1. Goal

Ship a Banquet Event Order surface that staff use to bartend an event, plus an admin "Finalize" action that locks the BEO and arms a single low-touch SMS reminder a few days before the event for any staffer who has not yet confirmed they have read the BEO.

## 2. Why

- We have promised clients a BEO already. The client-facing celebration copy on drink-plan submission says *"We'll use your selections to create a shopping list, a menu, and a BEO (Banquet Event Order) for your event"* (`docs/superpowers/specs/2026-05-19-potion-planner-implementation-design.md:220`, `:446`). No BEO surface exists.
- The comms spec defined a "BEO finalized notification" at section 3.16 (`docs/superpowers/specs/2026-05-20-automated-communication-design.md:807`) but explicitly deferred it pending the BEO build (`:1467`, `:1478`). Phase 4a wired staff SMS for every other touch and called BEO out as the one excluded item (`docs/superpowers/plans/2026-05-22-comms-phase4a-staff-sms.md:2974`).
- Bartenders today get a 24-hour-before shift reminder with a shopping-list link. They have no consolidated view of the menu, addons, custom-menu treatment, logistics, and event-specific notes. The shopping-list link covers procurement, not service.

## 3. Decision record

Settled in brainstorming, captured here so the implementation plan inherits the intent:

- **Audience:** assigned staff on the event's shifts (the bartenders). Admin gets the same view through the existing event-detail entry. No client-facing variant.
- **Always-visible surface, gated confirm.** Staff can open the BEO at any drink-plan stage (`draft`, `submitted`, `reviewed`, or finalized). The "Confirm I've read this" action is hidden / disabled until admin clicks Finalize.
- **No notification on Finalize.** Pull model with one nudge: a single SMS goes out at MAX(event_date minus 3 days, NOW() plus small buffer) only to staffers who have not yet confirmed. This replaces the fan-out-on-finalize model in spec 3.16.
- **Admin lifecycle:** keep the existing "Mark reviewed" affordance, add "Finalize BEO" (gated on `reviewed`), and add "Unfinalize" (which clears `finalized_at` and every linked `beo_acknowledged_at` so a major late edit can force re-confirmation).
- **Edits after Finalize are allowed.** Staff see the latest. Forcing re-acknowledgment is opt-in via Unfinalize then Finalize again, not automatic on every edit.
- **Confirm loop is portal-only.** A new column `shift_requests.beo_acknowledged_at` is the BEO ack column. The portal stamps it directly via the new acknowledge endpoint. The existing inbound SMS `CONFIRM` keyword stays bound to shift acknowledgment only (`shift_requests.acknowledged_at`); reusing it for BEO would harm the shift-ack flow because the BEO nudge SMS asks the staffer to tap a link, not reply with a keyword.
- **SMS-only nudge.** Staff already receive other event-related emails. SMS is the urgent ask, and the click-through is what we want to measure. Adding email later is a one-template addition if data says we need it.

## 4. Non-goals

- No drink-plan content changes. The BEO is a derived view over `drink_plans`, `proposals`, `proposal_addons`, `shifts`, `shift_requests`, and `clients`.
- No new shopping-list mechanics. The BEO links to the existing `/shopping-list/:token` view (already approved by admin via the shopping-list approval flow).
- No client-facing BEO. Clients see their drink plan via the planner; they do not see a BEO.
- No version history. One finalized snapshot at a time; admin can edit freely after Finalize, and Unfinalize clears acks if a fresh read-through must be forced.
- No PDF export or print stylesheet in v1. The portal page renders fine on mobile and that is the primary device.
- No "BEO finalized" email. The comms spec 3.16 called for SMS plus email at finalize; we are deliberately swapping both for a single conditional SMS at T-3.

## 5. Current mechanism (verified)

**Drink plan as data backbone (`server/db/schema.sql:336`, `server/routes/drinkPlans.js`).** `drink_plans` is linked to `proposals` post-deposit. Statuses: `pending`, `draft`, `submitted`, `reviewed`. `selections JSONB` holds every drink-plan choice. `admin_notes TEXT` and `consult_selections JSONB` (the admin-only consult form) provide additional bartender context. `shopping_list JSONB` plus `shopping_list_status` cover procurement.

**Admin entry point today (`client/src/components/DrinkPlanCard.js:57`).** The card on the admin EventDetailPage has a "Mark reviewed" button that flips status `submitted` to `reviewed` via `PATCH /api/drink-plans/:id/status`. No notification fires.

**Shift model (`server/db/schema.sql:274`, `:295`).** `shifts` link to `proposals.id`. `shift_requests` join staff (`users`) to a shift with `status` `pending` / `approved` / `denied`. The "approved" set is the BEO recipient list.

**Existing scheduled-message infrastructure (`server/utils/staffShiftHandlers.js`, `server/utils/scheduledMessageDispatcher.js`).** Phase 4a shipped `scheduleStaffShiftMessages` (idempotent insert pattern), `loadStaffShiftContext`, `registerHandler(messageType, fn, { offsetFromEventDate, anchor, category, priority })`, the dispatcher's `checkSuppression` step, and a reschedule re-anchor cascade. The BEO nudge slots into this infrastructure.

**Existing inbound SMS handler (`server/utils/smsInbound.js`).** `detectResponseCode` recognises `confirm` and `cant`. `handleConfirm` finds the staffer's nearest approved upcoming shift and stamps `shift_requests.acknowledged_at`. We extend, not replace, this routing.

**Staff portal structure.** Pages already exist at `client/src/pages/staff/`: `StaffDashboard`, `StaffEvents`, `StaffShifts`, `StaffSchedule`, `StaffProfile`, `StaffResources`. They live under the `staff.drbartender.com` domain via the existing `StaffLayout` wrapper.

## 6. Architecture

### 6.1 Schema additions

Three idempotent columns. No migration of existing data needed (defaults are NULL).

```sql
ALTER TABLE drink_plans
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalized_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE shift_requests
  ADD COLUMN IF NOT EXISTS beo_acknowledged_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_drink_plans_finalized_at
  ON drink_plans(finalized_at) WHERE finalized_at IS NOT NULL;
```

`finalized_at` doubles as the boolean ("is this finalized?") and the timestamp for display. `finalized_by` traces who finalized for accountability; the `ON DELETE SET NULL` keeps the column from blocking deletion of an admin user who has ever finalized a BEO. `beo_acknowledged_at` lives on `shift_requests` rather than `users` because acknowledgment is per-event-per-staffer.

The partial index on `finalized_at` keeps the index small (we only ever filter on the small finalized subset, never the unfinalized majority).

**Existing partial unique index on `scheduled_messages`.** The dispatcher already has a partial unique index on `(entity_id, entity_type, message_type, recipient_id, recipient_type, channel) WHERE status='pending'` (see the `ON CONFLICT` clause in `staffShiftHandlers.js:209`). BEO inserts use the same index to make concurrent insertion race-safe via `ON CONFLICT DO NOTHING`. No new index is needed.

### 6.2 Routes

All write endpoints wrap their multi-table mutations in a single `BEGIN/COMMIT/ROLLBACK` transaction using the existing `pool.connect()` + try/catch/finally pattern from `drinkPlans.js`. The activity-log insert and the nudge-scheduling helper both run on the transaction client so a rollback leaves no orphans. Per CLAUDE.md, "Multi-table writes wrapped in `BEGIN/COMMIT/ROLLBACK`" is non-negotiable here.

**`POST /api/drink-plans/:id/finalize`** (`auth`, `requireAdminOrManager`, `drinkPlanWriteLimiter`). Inside one transaction: (1) `UPDATE drink_plans SET finalized_at = NOW(), finalized_by = req.user.id WHERE id = :id AND status = 'reviewed' AND finalized_at IS NULL RETURNING *`. If the UPDATE matches zero rows, ROLLBACK and respond 409 (either the plan is not in `reviewed` or it is already finalized; concurrent Finalize clicks see this and only the first one proceeds). (2) Call `scheduleBeoNudgesForProposal(proposalId, txClient)` (see 6.4) which inserts pending `beo_unack_nudge_sms` rows for each currently-approved staffer linked to any shift on the proposal. (3) INSERT into `proposal_activity_log` with `action = 'beo_finalized'`. COMMIT. Returns the updated plan.

The combination of the `finalized_at IS NULL` UPDATE guard (one transaction wins) and the partial unique index on `scheduled_messages` (catches any race that slips past application code) gives belt-and-suspenders dedup of the SMS schedule under concurrent Finalize clicks.

**`POST /api/drink-plans/:id/unfinalize`** (`auth`, `requireAdminOrManager`, `drinkPlanWriteLimiter`). Guard: `finalized_at IS NOT NULL`. Inside one transaction: (1) UPDATE `drink_plans` SET `finalized_at = NULL`, `finalized_by = NULL`. (2) UPDATE `shift_requests` SET `beo_acknowledged_at = NULL` for every approved request linked to this proposal. (3) UPDATE `scheduled_messages` SET `status = 'suppressed'`, `error_message = 'unfinalized'` WHERE `entity_type = 'proposal'` AND `entity_id = :proposalId` AND `message_type = 'beo_unack_nudge_sms'` AND `status = 'pending'`. Sent rows are deliberately left in place to preserve the audit trail. (4) INSERT into `proposal_activity_log` with `action = 'beo_unfinalized'`. COMMIT. Returns the updated plan.

The audit-preserving suppression in step 3 means a future Refinalize must use a status-aware idempotency check that ignores `status='suppressed'` rows when deciding whether to insert (see 6.4).

**`PATCH /api/drink-plans/:id/status` guard (modification to existing route).** The existing status-change route allows admins to revert a plan to `draft` or `pending`. Add a guard: if `finalized_at IS NOT NULL` AND the target status is anything other than the current status, throw a 409 with `"Plan is finalized. Unfinalize first to change status."` This preserves the invariant that finalized plans are locked. Reverting from finalized must go through the explicit Unfinalize endpoint, which knows to clear acks and suppress nudges.

**`GET /api/beo/:proposalId`** (`auth`, `publicReadLimiter`). Returns a single JSON payload composing the BEO content (see 7). Authorization rule:
- Admin / manager: always allowed.
- Staff: allowed if the user has an `approved` `shift_requests` row on a non-cancelled shift whose `proposal_id` matches `:proposalId` (see section 9 for the exact SQL with the `s.status != 'cancelled'` guard).
- Otherwise: 403.

**`POST /api/beo/:proposalId/acknowledge`** (`auth`, `drinkPlanWriteLimiter`). Stamps `shift_requests.beo_acknowledged_at = NOW()` for every approved `shift_requests` row that belongs to this user on any shift linked to this proposal where the linked drink plan is finalized, in a single atomic UPDATE...FROM:

```sql
UPDATE shift_requests sr
   SET beo_acknowledged_at = NOW()
  FROM shifts s
  JOIN drink_plans dp ON dp.proposal_id = s.proposal_id
 WHERE sr.shift_id = s.id
   AND s.proposal_id = $1
   AND sr.user_id = $2
   AND sr.status = 'approved'
   AND dp.finalized_at IS NOT NULL
RETURNING sr.id, sr.beo_acknowledged_at
```

This collapses the "is finalized?" check and the stamp into one statement. A concurrent Unfinalize that flips `finalized_at` to NULL between a hypothetical SELECT and UPDATE cannot leave an orphan ack on an un-finalized plan. If the UPDATE returns zero rows (plan not finalized, or no approved request for this user), respond 409 with the specific reason. Admin acknowledgment is a no-op (no `shift_requests` row); returns 200 with `acknowledged: false`.

The finalize / unfinalize endpoints live in `server/routes/drinkPlans.js` (next to the existing status route). The BEO read and acknowledge endpoints live in a new `server/routes/beo.js` (mounted at `/api/beo`) so the BEO surface has its own module rather than bolting more onto `drinkPlans.js`.

**Existing GET endpoints that must be updated to project the new columns** (the spec's cross-cutting consistency requirement). See section 6.8 for the full list.

### 6.3 The nudge: `beo_unack_nudge_sms`

A new scheduled-message type registered through the existing dispatcher.

```js
registerHandler('beo_unack_nudge_sms', handleBeoUnackNudge, {
  offsetFromEventDate: null,   // bespoke timing (see below)
  anchor: 'event_date',         // for reschedule re-anchor
  category: 'operational',     // not gated by communication_preferences.marketing_enabled
  priority: 2,                 // action-required ladder (per Phase 4b priority table)
});
```

`offsetFromEventDate: null` matches `shift_reminder` and `staff_thank_you`: the generic offset cascade skips it, and we re-anchor explicitly on reschedule (see 6.4).

**Entity scoping.** Rows are inserted with `entity_type = 'proposal'`, `entity_id = proposalId` (not `shift`, despite the recipient being a per-shift staffer). Three reasons:

1. The BEO is one document per event, so the natural unit of dedupe is per-proposal-per-staffer. A staffer assigned to two shifts on the same proposal must receive ONE nudge, not two.
2. The existing `checkSuppression` in `scheduledMessageDispatcher.js:122` already cascades `entity_type='proposal'` against `proposals.status='archived'`, so the archived-cascade is free.
3. Shift cancellation suppression needs new code regardless (see 6.6) because the existing `entity_type='shift'` suppression in `server/routes/shifts.js:537` is hardcoded to `shift_reminder`/`staff_thank_you`.

**`scheduledFor` formula.** `MAX(event_start_utc - 3 days, NOW() + 5 minutes)`, with a strict `event_start_utc >= NOW()` guard: if the event has already started or finished (admin finalizing late paperwork on a past event), the scheduling helper skips the insert entirely. We never SMS staff about a past event.

The five-minute buffer prevents a finalize-then-immediate-dispatch race that could land before the row is fully committed.

**Pre-dispatch gate via `SuppressMessageError`.** The dispatcher's `dispatchRow` unconditionally writes `status='sent'` after the handler returns without throwing (`scheduledMessageDispatcher.js:482`), so any in-handler `UPDATE ... SET status='suppressed'` would be clobbered. The correct mechanism is to throw a known error class the dispatcher catches:

1. Add a new `SuppressMessageError` class in `server/utils/errors.js`. It carries a `reason` string.
2. Extend the dispatcher's existing `try/catch` around `await handler(...)` with a discriminator: `if (err instanceof SuppressMessageError) { UPDATE ... SET status='suppressed', error_message = err.reason }` and return without rethrowing. All other errors continue to flow through the existing `status='failed'` path.
3. The BEO handler loads context, evaluates the gate, and throws `new SuppressMessageError(reason)` when any condition fails. Otherwise renders + sends.

Gate conditions:

| Condition | `reason` |
|---|---|
| `drink_plans.finalized_at IS NULL` | `beo_not_finalized` (defensive; Unfinalize already suppresses pending rows) |
| any `shift_requests.beo_acknowledged_at IS NOT NULL` for this user on this proposal | `already_acknowledged` |
| no `approved` `shift_requests` for this user on any non-cancelled shift in this proposal | `staffer_unassigned` |
| event start (computed from proposal `event_date` + `event_start_time` + `event_timezone`) is in the past | `event_in_past` (covers the case where the event was rescheduled into the past after the row was scheduled; complements the scheduling-time guard in 6.4) |
| `proposals.status='archived'` | not reached here; `checkSuppression` already catches it earlier in `dispatchRow` |

If all gates pass, the handler renders the SMS body via `smsTemplates.staffBeoNudgeSms` and sends through `sendAndLogSms`.

**SMS body** (no em dashes, neutral tone, mirrors the existing staff SMS voice):

```
BEO ready from Dr. Bartender: [event_type_label] on [event_date_local]. Tap to review and confirm: [staff_beo_url]
```

`[staff_beo_url]` is `${STAFF_URL}/events/${proposalId}/beo`. The CTA is "tap and confirm in the portal." The SMS does NOT instruct the staffer to reply (reusing the existing `CONFIRM` keyword would steal it from the shift-ack flow, which is the existing established behavior).

### 6.4 Scheduling rows

Two scheduling moments. Both use a new `insertBeoNudgeIfMissing` helper (NOT the existing `insertShiftMessageIfMissing`, because that one is status-agnostic and would block re-insertion after Unfinalize suppresses a row; see below).

**On Finalize (`server/routes/drinkPlans.js`, finalize handler).** Inside the same transaction as the UPDATE that stamps `finalized_at`, call `scheduleBeoNudgesForProposal(proposalId, txClient)` (in `server/utils/beoHandlers.js`). The helper:

1. Loads the proposal's `event_date`, `event_start_time`, `event_duration_hours`, `event_timezone`.
2. Computes `eventStartUtc` via `computeEventStartUtc(...)`. If `eventStartUtc < NOW()`, **return without inserting**. We never schedule a BEO nudge for a past event.
3. Computes `scheduledFor = MAX(eventStartUtc - 3 days, NOW() + 5 minutes)`.
4. Selects DISTINCT `user_id` across every approved `shift_requests` row on every non-cancelled shift linked to this proposal. One row per staffer, even if the staffer is on two shifts.
5. For each `user_id`, calls `insertBeoNudgeIfMissing(txClient, { proposalId, userId, scheduledFor })`. The helper inserts a `scheduled_messages` row with `entity_type='proposal'`, `entity_id=proposalId`, `message_type='beo_unack_nudge_sms'`, `recipient_type='staff'`, `recipient_id=user_id`, `channel='sms'`, `scheduled_for=...`.

`insertBeoNudgeIfMissing` is status-aware AND race-safe: it SELECTs for an existing row on the natural key with `status IN ('pending','sent')`. If one exists, skip. If only `suppressed` or `failed` rows exist, proceed to INSERT with `ON CONFLICT (entity_id, entity_type, message_type, recipient_id, recipient_type, channel) WHERE status='pending' DO NOTHING` using the existing partial unique index (see 6.1). This is the crucial difference from `insertShiftMessageIfMissing` and is what makes the Unfinalize-then-Finalize loop work cleanly: the previous run's pending rows became `suppressed` on Unfinalize, so they no longer block re-insertion, but `sent` rows from earlier dispatches still block. The `ON CONFLICT` is defense-in-depth against any race that slips past the application-level SELECT-then-INSERT (also caught upstream by the Finalize `finalized_at IS NULL` UPDATE guard).

The acknowledgment reset on Unfinalize is what guarantees a "fresh acknowledgment is needed" situation also gets a fresh nudge in practice: when admin Unfinalizes intending to push a re-ack, they must `Finalize` again, and between the two clicks any in-flight pending rows have been suppressed. If a sent row from a prior finalize cycle blocks a new pending insert, that's the rare case where admin should bump the nudge manually (out of scope for v1; the admin can re-send via the dispatcher's manual-retry path if needed).

Best-effort wrapping: `scheduleBeoNudgesForProposal` is called inside the Finalize transaction, so a scheduling failure rolls the whole Finalize back. This is intentional: a Finalize without nudges is a Finalize that silently fails its core promise. Errors propagate; the route returns 5xx and the admin retries.

**On fresh shift assignment (`server/utils/staffShiftHandlers.js`, in `scheduleStaffShiftMessages`).** The existing query joins `shifts` to `proposals` but NOT `drink_plans`. Add a `LEFT JOIN drink_plans dp ON dp.proposal_id = p.id` and SELECT `dp.finalized_at`. After the existing `shift_reminder` and `staff_thank_you` insert block, add a branch: if `dp.finalized_at IS NOT NULL` AND the just-approved staffer does NOT already have a BEO nudge row for this proposal (the natural-key check), call `insertBeoNudgeIfMissing` for the staffer.

This covers the "BEO was finalized weeks ago, admin assigns a staffer late" case without a new call site, because `scheduleStaffShiftMessages` is already invoked whenever a `shift_request` is approved (`server/routes/shifts.js` handlers).

**On reschedule.** Extend `staffShiftHandlers.reanchorStaffShiftMessages` to also update pending `beo_unack_nudge_sms` rows. The existing function iterates per-shift to re-anchor `shift_reminder` / `staff_thank_you` rows. BEO rows are scoped per-proposal, so the BEO reanchor runs ONCE per proposal, OUTSIDE the per-shift loop (running it inside the loop would issue N redundant identical UPDATEs for an N-shift event). Concretely: after the existing per-shift loop completes, run a single UPDATE on `scheduled_messages` where `entity_type='proposal'`, `entity_id=proposalId`, `message_type='beo_unack_nudge_sms'`, `status='pending'`, setting `scheduled_for = MAX(new_event_start_utc - 3 days, NOW() + 5 minutes)`. If `new_event_start_utc < NOW()`, skip the BEO UPDATE entirely; the row stays pending and the dispatch-time `event_in_past` gate (6.3) handles it on the next tick. The function handles the `no BEO rows yet because Finalize hasn't been clicked` case cleanly: the UPDATE matches zero rows and is a no-op.

### 6.5 Confirm loop

**Portal-only.** The staff portal BEO page renders a sticky bottom-of-viewport action bar. When `finalized_at IS NOT NULL` and the user has at least one unacked approved `shift_request` on this proposal, the bar shows "Confirm I've read this BEO" as a primary button. Click POSTs `/api/beo/:proposalId/acknowledge`. On success: the bar swaps to a quiet "Confirmed [date_time]" pill. On failure: toast plus the button stays.

The inbound SMS `CONFIRM` keyword is NOT reused for BEO acknowledgment. Reasons:

- The BEO nudge SMS instructs the staffer to tap a link, not reply with a keyword. Rerouting CONFIRM would solve a non-problem.
- If a staffer happened to reply CONFIRM after seeing the nudge, the rerouted CONFIRM would stamp `beo_acknowledged_at` but leave their `shift_requests.acknowledged_at` un-stamped, leaving the shift schedule looking un-confirmed and confusing the on-call admin.
- Forcing the staffer through the portal click also gives us a portal-visit signal, which is the whole point of the confirm requirement.

`server/utils/smsInbound.js` and its existing `handleConfirm` path stay untouched. No new code in that file.

**Admin acknowledgment view.** On the admin EventDetailPage, the staff-assignment block (existing) gains a small per-staffer pill: `Not opened` or `Confirmed [time]`. Data source: `shift_requests.beo_acknowledged_at`.

### 6.6 Suppression matrix

Single source of truth for what suppresses a BEO nudge row. Read top to bottom; first match wins.

| Trigger | Row state | Where the suppression happens |
|---|---|---|
| Admin Unfinalize | pending → `status='suppressed'`, `error_message='unfinalized'`; sent rows preserved | Inside the Unfinalize endpoint (section 6.2) |
| Proposal archived | `status='suppressed'`, reason `archived: ...` | Dispatcher `checkSuppression` (already covers `entity_type='proposal'` at `scheduledMessageDispatcher.js:124`) |
| Shift cancellation OR staffer unassignment | pending → `status='suppressed'`, reason `staffer_unassigned`, **only when the staffer has no other approved active shifts on this proposal** | New code in `server/routes/shifts.js` cancel-or-unassign handler (see below). The existing `entity_type='shift'` UPDATE at `shifts.js:537` and `:553` is hardcoded to `shift_reminder`/`staff_thank_you`; that path does NOT cover BEO because the BEO row carries `entity_type='proposal'`, not `'shift'` |
| `shift_requests.beo_acknowledged_at IS NOT NULL` at dispatch | `status='suppressed'`, reason `already_acknowledged` | Handler throws `SuppressMessageError` (section 6.3) |
| `finalized_at IS NULL` at dispatch (defensive) | `status='suppressed'`, reason `beo_not_finalized` | Handler throws `SuppressMessageError` |

**Shift-cancellation suppression detail.** The existing `cancel-or-unassign` handler at `shifts.js:520` selects `shiftId` from the URL parameter; it does NOT currently load `proposal_id`. Step one of the modification: at handler entry, SELECT `proposal_id` from `shifts WHERE id = :shiftId` (it must happen before the existing UPDATEs so the value is available throughout). Then, alongside the existing two UPDATEs at lines 537 and 553, add a third UPDATE that scopes to BEO rows with a `NOT EXISTS` guard:

```sql
UPDATE scheduled_messages SET status='suppressed', error_message='staffer_unassigned'
 WHERE entity_type='proposal' AND entity_id=$1   -- $1 = proposal_id (newly SELECTed)
   AND message_type='beo_unack_nudge_sms'
   AND recipient_id = ANY($2)
   AND status='pending'
   AND NOT EXISTS (
     SELECT 1
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
      WHERE sr.user_id = scheduled_messages.recipient_id
        AND sr.status = 'approved'
        AND s.proposal_id = $1
        AND s.status != 'cancelled'
   )
```

The `NOT EXISTS` guard ensures the BEO nudge is only suppressed when the staffer has no remaining approved active shifts on the proposal. If they were on two shifts and one cancelled, they still need the BEO nudge for the surviving shift.

**Acknowledgment reset on re-approval.** When a `shift_requests` row transitions from `denied` (or `pending`) to `approved` (the assign / re-approve path in `shifts.js`), clear any stale `beo_acknowledged_at`. Without this, a staffer who was denied, then later re-approved, would carry their old acknowledgment forward and the dispatch-time gate would treat them as already-acked, skipping the new nudge they actually need. The fix is a single column in the existing UPDATE / INSERT...ON CONFLICT DO UPDATE statement:

```sql
ON CONFLICT (shift_id, user_id) DO UPDATE
  SET status = EXCLUDED.status,
      beo_acknowledged_at = NULL,   -- new: clear stale ack on re-approve
      ...
```

This pairs with the cancellation-suppression: cancelling a shift suppresses pending BEO rows; re-approving the staffer (potentially on another shift in the same proposal) clears their ack so the next Finalize cycle's nudge fires correctly.

### 6.7 Staff portal discovery

Two additions outside the BEO page itself so staff can find it.

**`client/src/pages/staff/StaffShifts.js`.** Today the card shows the event header, date, time, setup time, location, positions, and the request / status block. Add a small inline "View BEO" badge + link, gated to render ONLY when this staffer's `shift_requests.status === 'approved'` for this shift. (The page lists shifts available for request too; an unapproved staffer clicking "View BEO" would hit the 403 from the auth check in 9.) State badge values:

- `Draft` (drink plan exists, not yet `submitted` / `reviewed`)
- `Ready` (drink plan finalized, staffer has not acked)
- `Confirmed` (`beo_acknowledged_at IS NOT NULL`)
- hide the badge entirely if the staffer is not approved on this shift OR the drink plan does not yet exist

**`client/src/pages/staff/StaffEvents.js`.** Mirror the same badge / link in whatever row treatment that page uses today.

The badge color uses the existing palette: amber for `Ready` (action-required), green for `Confirmed`, muted for `Draft`. No new color tokens.

### 6.8 Consumer endpoints requiring projection updates

Cross-cutting consistency (CLAUDE.md): adding `drink_plans.finalized_at`, `finalized_by`, and `shift_requests.beo_acknowledged_at` requires updating every existing GET that the new UI surfaces consume. Five endpoints need projection / JOIN updates:

| Endpoint | Change | Consumer |
|---|---|---|
| `GET /api/drink-plans` (list) | SELECT `finalized_at` | Admin drink-plans dashboard table (can show finalized status without a per-row detail fetch) |
| `GET /api/drink-plans/:id` | SELECT `finalized_at`, `finalized_by` | `DrinkPlanCard` (Finalize / Unfinalize button gating, "Finalized [time]" readout) |
| `GET /api/drink-plans/by-proposal/:proposalId` | SELECT `finalized_at`, `finalized_by` | Same |
| `GET /api/shifts/by-proposal/:proposalId` | When projecting `approved_staff` (today an array of name strings), switch to `json_agg(json_build_object('user_id', sr.user_id, 'name', ..., 'beo_acknowledged_at', sr.beo_acknowledged_at))` | Admin EventDetailPage per-staffer "Confirmed [time]" pill |
| `GET /api/shifts` (staff path) | LEFT JOIN `drink_plans dp ON dp.proposal_id = s.proposal_id`, SELECT `dp.finalized_at`, plus the requester's `sr.beo_acknowledged_at` | StaffShifts View BEO badge state |
| `GET /api/shifts/user/:userId/events` | Same as above | StaffEvents View BEO badge state |

**Frontend consumer changes that fall out of the new data shapes.** `EventDetailPage.js` currently does `approved_staff.join(', ')` to render the staff list. Once that field becomes an array of objects, the join would render `[object Object]`. The page must map the array, rendering both each staffer's name and a Confirmed-or-Not-opened pill. This change is part of section 10 Files; it is called out here so the cross-cutting consumer audit is complete.

The exact column lists in each endpoint are an implementation-plan detail; the spec's contract is: every UI element that conditionally renders on `finalized_at` or `beo_acknowledged_at` has the data it needs without a second round trip, and every existing UI element that renders the data being reshaped is updated to handle the new shape.

## 7. BEO page content

`client/src/pages/staff/StaffBeo.js` renders the BEO. Mobile-first; this is bartender-in-the-parking-lot reading. Each section is a `card`.

### 7.1 Event header

- Client name plus a `tel:` link to client phone
- Event type label (via `getEventTypeLabel`)
- Date in event timezone, formatted "Saturday, August 15"
- Start time, end time, setup arrival time (`event_start_time` minus `setup_minutes_before`), all in event TZ
- Address (`event_location`) with a tap-to-open maps link
- Guest count, package name

### 7.2 Service plan

- Service style label (full bar / signatures / beer-wine / mocktail / custom-setup; derived from `drink_plans.serving_type` with friendly labels)
- Bar count and bartender count (`proposals.num_bars`, `proposals.num_bartenders`)
- For hosted packages, a one-line note that bartenders are included in the package up to a 1:100 ratio (consistent with `isHostedPackage` rule, just informational)

### 7.3 Drink menu

- Signature cocktails: name plus ingredient list, resolved from `cocktails` table by ID
- Mocktails: name plus ingredient list, resolved from `mocktails`
- Custom cocktails (if any), straight from `selections.customCocktails`
- Mixers for signature drinks (resolved from `selections.mixersForSignatureDrinks` and `selections.mixersForSpirits` based on serving type)
- Spirits selected (`selections.spirits`, `selections.spiritsOther`)
- Beer list (`selections.beerFromFullBar` or `selections.beerFromBeerWine` based on serving type)
- Wine list (`selections.wineFromFullBar` or `selections.wineFromBeerWine` based on serving type), including `selections.wineOther*` free-text additions
- Syrup list (`selections.syrupSelections`) with self-provided syrups (`selections.syrupSelfProvided`) labeled

### 7.4 Add-ons

Render `proposal_addons` joined to `service_addons` for names. Champagne toast (if present) shows its serving style (`selections.addOns?.['champagne-toast']?.servingStyle`). Bar rental shows quantity (each added bar is a separate addon line in current data).

### 7.5 Logistics

`selections.logistics` may include: bar rental flag, ice plan, cup plan, additional setup notes. Render whatever is present; omit empty sections rather than rendering an empty state.

### 7.6 Custom menu

If `selections.menuStyle` is `custom` or `house`: a card with `menuTheme`, `drinkNaming`, `menuDesignNotes`, and the uploaded logo (if `selections.companyLogo` is present, render via the existing token-gated `/api/drink-plans/t/:token/logo` proxy URL). Otherwise omit this card.

### 7.7 Special notes

Two distinct sources, clearly labeled in the UI:

- **Admin notes**: `drink_plans.admin_notes` (Dr. Bartender's internal prep notes)
- **From the client**: `selections.additionalNotes` (the catch-all "anything else?" textarea the client filled on the planner)

Both render as plain text; existing data is short-form. No rich text. If both are empty, omit the card.

### 7.8 Shopping list link

If `shopping_list_status = 'approved'`: a "View shopping list" link to `${PUBLIC_SITE_URL}/shopping-list/${drink_plan_token}`. Hosted events skip this (admin is doing the shopping); the existing approval flow already gates the email send for hosted vs BYOB.

### 7.9 Confirm action bar

Sticky to the bottom of the viewport on the BEO page.

- Drink plan not yet `finalized_at`: muted banner `"BEO still being prepped. Check back closer to the event."` No button.
- Drink plan finalized, this staffer has not acked: amber primary button `"Confirm I've read this BEO"`.
- Already acked: green pill `"Confirmed on [date and time]"`. No button.
- User is admin (no `shift_request` row): info pill `"You are viewing this as admin"`. No button.

## 8. Edge cases

- **Late finalize.** Admin finalizes the day before the event. `scheduledFor = NOW() + 5 minutes`. The nudge fires within minutes; if the staffer happens to have already opened the BEO and confirmed via the portal in that gap, the handler's gate suppresses it.
- **Past-event finalize.** Admin finalizes for an event that has already started or finished (catching up on paperwork after the fact). `scheduleBeoNudgesForProposal` sees `eventStartUtc < NOW()` and returns without inserting. No SMS goes out for past events. The Finalize itself still succeeds and stamps `finalized_at`.
- **Late assignment.** Admin assigns a new staffer the day before the event, when the BEO has been finalized for weeks. `scheduleStaffShiftMessages` (now joining `drink_plans`) sees `finalized_at` set, and `insertBeoNudgeIfMissing` creates a fresh nudge scheduled for `MAX(event_start - 3 days, NOW() + 5 minutes)`. The new staffer gets nudged within minutes.
- **Unfinalize then Finalize again.** Unfinalize suppresses pending rows with `error_message='unfinalized'` and clears `beo_acknowledged_at` on every linked `shift_requests`. The next Finalize calls `scheduleBeoNudgesForProposal` which uses the status-aware `insertBeoNudgeIfMissing`: existing rows with `status='suppressed'` do NOT block a new pending insert, so a fresh nudge is scheduled. Sent rows from prior cycles still block (rare; admin manually re-triggers if a staffer needs an explicit re-nudge).
- **Reschedule.** Event moves; the extended `reanchorStaffShiftMessages` loop updates `scheduled_for` on pending BEO nudge rows (matched by `entity_type='proposal'`). If the new date is now past T-3, the next dispatcher tick fires the nudge. If the new date moved a past-eligible event into the past, the UPDATE still runs but the dispatcher then suppresses the row when the handler discovers the staffer no longer has an approved active shift (or, if the event is genuinely past and never fires, the row sits pending until the next reschedule or the admin manually cleans it; this is the same behavior shift_reminder has today and is accepted).
- **Same proposal, two shifts for the same staffer.** ONE row per staffer per proposal (entity_type='proposal' dedupe). The `acknowledge` endpoint stamps every approved `shift_requests` row for that user on the proposal, so both shifts show "Confirmed" in admin views with one click. No duplicate SMS.
- **Shift cancelled, staffer still has another shift on the same proposal.** The new BEO suppression UPDATE in `shifts.js` is guarded by `NOT EXISTS`, so the BEO nudge stays pending because the staffer still has approved coverage on the surviving shift.
- **Admin views the BEO.** No `shift_request`, no acknowledgment. Endpoint returns 200 with the BEO payload; the page shows the "viewing as admin" pill.
- **Drink plan finalized but never `reviewed`.** Cannot happen: the Finalize endpoint guards on `status='reviewed'`.
- **Inbound CONFIRM from a staffer with both unacked shift and finalized BEO.** Unchanged from today: `handleConfirm` stamps `shift_requests.acknowledged_at`. The BEO ack remains un-stamped; the staffer is expected to confirm via the portal. This is deliberate (see 6.5).
- **Token-gated public link.** None. The BEO page lives under the authenticated staff portal at `staff.drbartender.com`. The shopping-list link inside the BEO uses the existing public token because that page is already public.

## 9. Authorization details

**Staff portal access.** Existing JWT cookie from `staff.drbartender.com` login. `auth` middleware on `/api/beo/*`. Authorization check in the route handler (not middleware) so admins bypass the shift-request check:

```js
if (req.user.role !== 'admin' && req.user.role !== 'manager') {
  const r = await pool.query(
    `SELECT 1 FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
      WHERE s.proposal_id = $1
        AND sr.user_id = $2
        AND sr.status = 'approved'
        AND s.status != 'cancelled'
      LIMIT 1`,
    [proposalId, req.user.id]
  );
  if (!r.rowCount) throw new PermissionError('You are not assigned to this event.');
}
```

The `s.status != 'cancelled'` clause is required because an admin can cancel a shift via the generic `PUT /api/shifts/:id` endpoint, which leaves the linked `shift_requests` rows at `status='approved'`. Without this clause, a staffer who was assigned to a shift that was later cancelled would still pass the auth check.

The frontend route `/events/:proposalId/beo` lives inside `StaffLayout`, which already requires login.

**The acknowledge endpoint** is gated identically. Admins call it as a no-op (no `shift_request` for them).

## 10. Files

### Server (new)
- `server/routes/beo.js`: GET `/api/beo/:proposalId`, POST `/api/beo/:proposalId/acknowledge`. Mounted in `server/index.js`. Both use the appropriate existing rate limiters (`publicReadLimiter`, `drinkPlanWriteLimiter`).
- `server/utils/beoHandlers.js`: `scheduleBeoNudgesForProposal(proposalId, executor)`, `insertBeoNudgeIfMissing(executor, { proposalId, userId, scheduledFor })`, `suppressBeoNudgesForProposal(proposalId, executor, reason)` (called by Unfinalize), `suppressBeoNudgesForStaffers(proposalId, userIds, executor)` (called by cancel-or-unassign), `handleBeoUnackNudge` dispatcher handler, `registerBeoHandlers()` bootstrap.
- `server/utils/beoHandlers.test.js`: scheduling idempotency, per-staffer dedupe across multiple shifts, gate evaluation, suppress-on-unfinalize preserves sent rows, late-finalize collapse to NOW+5min, past-event skip.
- `server/routes/beo.test.js`: authorization (staff with approved shift vs staff without; admin), acknowledge flow stamping all relevant shift_requests, acknowledge blocked when not finalized, rate-limit headers present.

### Server (modify)
- `server/db/schema.sql`: the three idempotent ALTERs + the partial index from 6.1, including `ON DELETE SET NULL` on `finalized_by`.
- `server/utils/errors.js`: add `SuppressMessageError` class with a `reason` property. Not an `AppError` subclass (dispatcher contract is internal; this error never surfaces to a client).
- `server/utils/scheduledMessageDispatcher.js`: `require` the new `SuppressMessageError` from `./errors`. Extend the `try/catch` around `await handler(...)` to discriminate `SuppressMessageError` (mark row `status='suppressed'` with the error's `reason`, return). Document the contract at the handler-registration callsite.
- `server/routes/drinkPlans.js`: add POST `/:id/finalize` and POST `/:id/unfinalize` next to the existing status route. Each wraps its writes in `pool.connect()` + `BEGIN/COMMIT/ROLLBACK`. Update the existing `PATCH /:id/status` to refuse any status change when `finalized_at IS NOT NULL` (the lock-when-finalized invariant). Update the existing `GET /` (list), `GET /:id`, and `GET /by-proposal/:proposalId` to SELECT `finalized_at` (and `finalized_by` on detail routes).
- `server/routes/shifts.js`: SELECT `proposal_id` at the entry of the cancel-or-unassign handler. Add the `beo_unack_nudge_sms` `NOT EXISTS`-guarded suppression UPDATE from section 6.6. In the assign / re-approve path (`POST /:id/assign` and any related `ON CONFLICT DO UPDATE` that flips status to `approved`), set `beo_acknowledged_at = NULL` to clear stale acks. Update `GET /shifts/by-proposal/:proposalId` so `approved_staff` carries `beo_acknowledged_at` per request (json_agg shape change). Extend `GET /shifts` (staff path) and `GET /shifts/user/:userId/events` with LEFT JOIN `drink_plans` for `finalized_at` and the requester's `beo_acknowledged_at`.
- `server/utils/smsTemplates.js`: add `staffBeoNudgeSms({ eventTypeLabel, eventDateLocal, beoUrl })`. SMS body keeps the word "confirm" deliberately: the goal is to drive staff to the portal where the click is itself the read-receipt signal.
- `server/utils/smsTemplates.test.js`: add the matching test cases (link present, no em dashes, expected phrasing).
- `server/utils/staffShiftHandlers.js`: extend `scheduleStaffShiftMessages` to LEFT JOIN `drink_plans` and conditionally enqueue the BEO nudge for the new staffer when the linked plan is finalized. Extend `reanchorStaffShiftMessages` to also re-anchor pending `entity_type='proposal'` BEO nudge rows, OUTSIDE the per-shift loop (one UPDATE per proposal, not per shift).
- `server/utils/staffShiftHandlers.test.js`: assignment-after-finalize, reschedule re-anchor for BEO nudge, no-op when finalize hasn't happened yet, reanchor runs exactly once per proposal regardless of shift count.
- `server/index.js`: mount `/api/beo`, register `registerBeoHandlers()` in the scheduler-bootstrap block.

**Not modified (deliberately).** `server/utils/smsInbound.js` stays as-is. The CONFIRM keyword remains bound to shift acknowledgment.

### Client (new)
- `client/src/pages/staff/StaffBeo.js`: the BEO viewer page.
- `client/src/pages/staff/StaffBeo.css`: scoped styles (cards, sticky action bar) if the existing classes need supplementing.

### Client (modify)
- `client/src/App.js`: add the `/events/:proposalId/beo` route under `StaffLayout`.
- `client/src/components/DrinkPlanCard.js`: add the "Finalize BEO" button (gated on `status='reviewed'`), the "Unfinalize" button (gated on `finalized_at !== null`), and a small "Finalized [time]" timestamp readout.
- `client/src/components/DrinkPlanCard.test.js` (if it exists, otherwise inline rendering smoke): button visibility per state.
- `client/src/pages/staff/StaffShifts.js`: add the "View BEO" badge + link described in 6.7. Gate render on `my_request_status === 'approved'` so an unapproved staffer cannot click into a 403.
- `client/src/pages/staff/StaffEvents.js`: same badge + link, same approved-only gate.
- `client/src/pages/admin/EventDetailPage.js`: add the "View BEO" link near the DrinkPlanCard. Replace `approved_staff.join(', ')` with a map over the new object array; render each staffer's name plus a `Confirmed [time]` / `Not opened` pill driven by `beo_acknowledged_at`.

### Docs (mandatory per CLAUDE.md)
- `README.md`: folder tree (new `beo.js` route, new `beoHandlers.js` util, new `StaffBeo.js` page); Key Features (add BEO surface line).
- `ARCHITECTURE.md`: route table (4 new rows for finalize / unfinalize / GET BEO / acknowledge); schema section (the three new columns); scheduled-message section (`beo_unack_nudge_sms`).
- `CLIENT_FACING_SURFACES.md`: not applicable (staff-facing, not client).

## 11. Testing approach

**Server unit tests** (node:test, real dev DB per existing pattern):

- `beoHandlers.test.js`:
  - `scheduleBeoNudgesForProposal` inserts ONE row per approved staffer per proposal (deduping across multiple shifts for the same staffer)
  - `scheduleBeoNudgesForProposal` skips cancelled shifts and un-approved requests
  - `scheduleBeoNudgesForProposal` with late finalize (event in 1 day) collapses `scheduled_for` to `NOW + 5min`
  - `scheduleBeoNudgesForProposal` with a past-event finalize returns 0 inserts (the strict `eventStartUtc >= NOW()` guard)
  - `insertBeoNudgeIfMissing` allows re-insertion when only suppressed rows exist (Refinalize after Unfinalize)
  - `insertBeoNudgeIfMissing` blocks re-insertion when a sent or pending row exists
  - `suppressBeoNudgesForProposal` UPDATEs pending to suppressed with reason, leaves sent rows alone
  - `suppressBeoNudgesForStaffers` only suppresses when the staffer has no remaining approved active shifts on the proposal (the `NOT EXISTS` guard)
  - `handleBeoUnackNudge` throws `SuppressMessageError` for each gate: not finalized, already acked, unassigned (one test per gate)
  - `handleBeoUnackNudge` sends + logs SMS via `sendAndLogSms` when all gates pass

- `scheduledMessageDispatcher.test.js` additions:
  - A handler throwing `SuppressMessageError` results in the row being marked `status='suppressed'` with the error's `reason` in `error_message`
  - A handler throwing any other error still flows through the existing `status='failed'` path
  - The proposal-archived path in `checkSuppression` catches `entity_type='proposal'` BEO rows correctly

- `beo.test.js` (route):
  - Staff with approved shift on the proposal can GET; staff without cannot (403)
  - Admin/manager can GET regardless of shift assignment
  - Acknowledge endpoint stamps `beo_acknowledged_at` on every approved `shift_request` for the user on the proposal
  - Acknowledge endpoint is a no-op (200, `acknowledged: false`) for admin
  - Acknowledge endpoint refuses when `finalized_at IS NULL` (409)
  - Rate-limit headers present on both endpoints

- `drinkPlans.test.js` additions (Finalize / Unfinalize):
  - Finalize succeeds with `status='reviewed'`, schedules nudges, writes activity-log row, returns updated plan
  - Finalize refuses when `status != 'reviewed'` (409)
  - Finalize refuses when `finalized_at IS NOT NULL` (409) and the UPDATE guard prevents duplicate scheduling
  - Finalize is transactional: a forced scheduling failure rolls back `finalized_at`
  - PATCH `/:id/status` refuses any status change when `finalized_at IS NOT NULL` (409, "Plan is finalized")
  - Unfinalize clears `finalized_at`, clears every linked `beo_acknowledged_at`, suppresses pending BEO rows with `error_message='unfinalized'`, preserves sent rows, writes activity-log row
  - Unfinalize is transactional under partial failure
  - Acknowledge endpoint atomic UPDATE returns zero rows when `finalized_at` is NULL (no orphan ack possible)
  - GET endpoints project `finalized_at` and `finalized_by` (list + detail + by-proposal)

- `shifts.test.js` additions:
  - cancel-or-unassign loads `proposal_id` from the shift before running the BEO suppression UPDATE
  - cancel-or-unassign suppresses BEO nudges when affected staffer has no other approved active shift on the proposal
  - cancel-or-unassign leaves BEO nudges PENDING when affected staffer still has another approved active shift
  - assign / re-approve clears `beo_acknowledged_at = NULL` so a re-approved staffer gets a fresh nudge on the next Finalize cycle
  - auth check on `GET /api/beo/:proposalId` rejects a staffer whose only approved request is on a cancelled shift
  - GET `/shifts/by-proposal/:proposalId` projects `approved_staff` as an array of objects with `beo_acknowledged_at`
  - GET `/shifts` (staff) projects `finalized_at` and the requester's `beo_acknowledged_at`
  - GET `/shifts/user/:userId/events` projects the same

- `staffShiftHandlers.test.js` additions:
  - `scheduleStaffShiftMessages` on a freshly approved staffer with a finalized drink plan inserts the BEO nudge row
  - `scheduleStaffShiftMessages` on a freshly approved staffer with an UNfinalized drink plan does NOT insert a BEO nudge (no-op branch)
  - `reanchorStaffShiftMessages` updates `scheduled_for` on pending BEO rows when the event is rescheduled

Note: `smsInbound.js` and its test file are deliberately unchanged. The CONFIRM keyword stays bound to shift acknowledgment.

**Client smoke tests** (existing `react-scripts` build under `CI=true` is the gate):

- `CI=true react-scripts build` passes
- Manual: open the BEO page as staff (approved shift), confirm button visible after finalize, acknowledge persists across refresh, badge in StaffShifts swaps from Ready to Confirmed

**Manual verification matrix** (ship gate):

1. Admin: Drink-plan card shows Mark reviewed, then Finalize BEO, then Unfinalize, in that gated order
2. Admin: Finalize on a proposal with two approved staffers schedules two pending nudge rows at the expected `scheduled_for`
3. Admin: Finalize on a proposal where one staffer is on two shifts of the same proposal schedules ONE nudge for that staffer (not two)
4. Admin: Unfinalize suppresses pending nudges, clears `beo_acknowledged_at`, leaves any prior sent rows in place
5. Staff: Open BEO pre-finalize shows banner, no button. Post-finalize shows button. Click shows pill.
6. Staff: SMS CONFIRM with finalized-unacked BEO runs the existing shift-ack flow (stamps `acknowledged_at`); BEO ack stays un-stamped (deliberate per 6.5)
7. Late finalize: finalize a proposal whose event is in 2 days; nudge fires within minutes
8. Past-event finalize: finalize a proposal whose event was yesterday; Finalize succeeds, NO nudge scheduled, NO SMS sent
9. Late assignment: approve a fresh `shift_request` on a finalized proposal; nudge row appears within seconds
10. Reschedule: change the event date by 7 days; pending nudge `scheduled_for` updates correctly
11. Archive: archive a proposal with a pending nudge; next dispatcher tick suppresses the row via existing `checkSuppression`
12. Shift cancellation, staffer-multi-coverage: staffer on shifts A and B for one proposal; cancel shift A; BEO nudge stays PENDING because of the `NOT EXISTS` guard
13. Concurrent Finalize clicks: two admin sessions both click Finalize within the same second; exactly ONE Finalize succeeds, the other gets 409; one batch of nudge rows is scheduled
14. Reverted finalized plan: PATCH `/api/drink-plans/:id/status` with target `draft` on a `finalized_at IS NOT NULL` plan returns 409
15. Past-event reschedule: pending BEO nudge on an event that gets rescheduled into the past; dispatcher fires the row, handler throws `SuppressMessageError('event_in_past')`, row marked suppressed instead of SMS sent
16. Reassignment with stale ack: deny a previously-approved staffer (whose `beo_acknowledged_at` is set), re-approve them; their `beo_acknowledged_at` is now NULL and the next nudge fires correctly

## 12. SMS dispatcher gate: `SuppressMessageError`

The dispatcher's existing handler contract is "handler runs, success means the row is marked `sent`, throw means the row is marked `failed`." We need a third outcome: "the row should be suppressed for a known reason without alerting." A self-mutation by the handler does NOT work because `scheduledMessageDispatcher.js:482` unconditionally writes `status='sent'` after the handler returns, clobbering any in-handler status update.

The fix: a dedicated error class the dispatcher catches and maps to `suppressed`.

1. Add `SuppressMessageError` to `server/utils/errors.js`:

```js
class SuppressMessageError extends Error {
  constructor(reason) {
    super(`message suppressed: ${reason}`);
    this.name = 'SuppressMessageError';
    this.reason = reason;
  }
}
```

This intentionally does NOT extend `AppError`. It is an internal dispatcher contract, never surfaced to a client.

2. Add the require at the top of `server/utils/scheduledMessageDispatcher.js` (the file currently does not import any error classes):

```js
const { SuppressMessageError } = require('./errors');
```

3. Extend the dispatcher's `dispatchRow` try/catch with a discriminator BEFORE the existing failure branch:

```js
try {
  await handler({ entity, recipient, scheduledMessage: row });
  await pool.query(
    "UPDATE scheduled_messages SET status='sent', sent_at=NOW(), error_message=NULL WHERE id=$1",
    [row.id]
  );
} catch (err) {
  if (err instanceof SuppressMessageError) {
    await pool.query(
      "UPDATE scheduled_messages SET status='suppressed', error_message=$2 WHERE id=$1",
      [row.id, err.reason]
    );
    return;
  }
  // existing failure path unchanged
  ...
}
```

4. Handlers (BEO is the first) throw `new SuppressMessageError('reason')` for any expected gate failure. Unexpected failures (DB unreachable, null pointer) continue to throw normally and flow through the existing `failed` path with Sentry.

This is the only viable pattern given the existing dispatcher contract. The same `SuppressMessageError` is available to any future handler that needs the third outcome.

## 13. Risk and rollback

- **Schema additions are additive and nullable.** Rollback = `ALTER TABLE ... DROP COLUMN`. Index is small.
- **Notification handler is best-effort.** Suppression and failure are isolated; a single bad row never affects the rest of the dispatcher queue.
- **No money path involvement.** No pricing logic, no Stripe, no invoice mutation.
- **Worst-case bug:** a staffer gets a duplicate nudge SMS, or sees the BEO page render incorrectly. Both are recoverable in-place without data damage.

Primary risk to call out: the inbound SMS CONFIRM behavior changes for staff with both an unacked shift and a finalized-unacked BEO. The reply text differs (mentions BEO rather than the event shift). This is a deliberate UX change; verification matrix item 5 covers it. If staff find it confusing, swap the reply text without changing behavior.

## 14. Out of scope / follow-ups

- Email channel for the nudge (defer; SMS-only ships; add if open rates demand it)
- BEO PDF export / print stylesheet
- Per-staffer ack channel column on `shift_requests` (defer; v1 just shows time)
- BEO version history (deferred; Unfinalize loop is the v1 escape hatch)
- Acknowledgment expiry (e.g., re-ack required if event > 30 days out and BEO changed). Out for v1.
- A "View BEO" link from the staff WhatsApp group flow. Out, not the right channel.
