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

**Drink plan as data backbone (`server/db/schema.sql:336`, `server/routes/drinkPlans.js`).** `drink_plans` is linked to `proposals` post-deposit. Statuses CHECK enum has FIVE values: `pending`, `draft`, `exploration_saved` (inert legacy from the removed Exploration phase), `submitted`, `reviewed`. The existing `PATCH /:id/status` whitelist (`drinkPlans.js:978`) covers only four of those and throws `ValidationError('Invalid status.')` if `exploration_saved` is passed; the legacy status is intentionally not API-mutable, so there is nothing to fix here. The BEO work inherits this enum as-is. `selections JSONB` holds every drink-plan choice. `admin_notes TEXT` and `consult_selections JSONB` (the admin-only consult form) provide additional bartender context. `shopping_list JSONB` plus `shopping_list_status` cover procurement.

**Admin entry point today (`client/src/components/DrinkPlanCard.js:163`).** The card on the admin EventDetailPage has a "Mark reviewed" button in the JSX action block (~lines 133-166; the `markReviewed` handler is at line 57). It flips status `submitted` to `reviewed` via `PATCH /api/drink-plans/:id/status`. No notification fires.

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

**Rate limiter note.** The existing `drinkPlanWriteLimiter` (`server/middleware/rateLimiters.js:33`) and `publicReadLimiter` both key by `req.params?.token` or `req.ip`. BEO routes carry `:id` or `:proposalId`, not `:token`, so both collapse to client IP. For the WRITE routes (`finalize`, `unfinalize`, admin-only) the IP fallback is acceptable (low volume, admin-only). For the READ route (`GET /api/beo/:proposalId`) the IP fallback is NOT acceptable: a busy event with 4 bartenders on the same venue wifi or office NAT or CGNAT would have all four share one bucket and could lock each other out under the standard 100/15min cap.

Add a new `beoReadLimiter` to `rateLimiters.js` keyed by `req.user?.id`, following the existing user.id-keyed pattern (`adminWriteLimiter` keyed by `admin-${req.user.id}` at line 100, `searchLimiter` at line 113). Use 60/15min per-user; comfortable headroom for one staffer refreshing repeatedly while standing in a venue parking lot. Apply this limiter to `GET /api/beo/:proposalId` instead of `publicReadLimiter`.

**`POST /api/drink-plans/:id/finalize`** (`auth`, `requireAdminOrManager`, `drinkPlanWriteLimiter`). Inside one transaction: (1) `UPDATE drink_plans dp SET finalized_at = NOW(), finalized_by = req.user.id FROM proposals p WHERE dp.id = :id AND dp.proposal_id = p.id AND dp.status = 'reviewed' AND dp.finalized_at IS NULL AND p.status != 'archived' AND COALESCE(dp.selections, '{}'::jsonb) != '{}'::jsonb RETURNING dp.*, dp.proposal_id`. The non-empty-selections guard prevents finalizing a row where admin flipped status to `reviewed` without the client ever submitting the planner. If the UPDATE matches zero rows, ROLLBACK and respond 409 with a reason (`not_reviewed`, `already_finalized`, `archived`, or `no_selections`); concurrent Finalize clicks see this and only the first one proceeds. (2) Read `proposal_id` from the RETURNING row (not via a separate SELECT, which would break the single-transaction promise) and call `scheduleBeoNudgesForProposal(proposalId, txClient)` (see 6.4) which inserts pending `beo_unack_nudge_sms` rows for each currently-approved staffer linked to any shift on the proposal. (3) INSERT into `proposal_activity_log` with `action = 'beo_finalized'`. COMMIT. Returns the updated plan.

The combination of the `finalized_at IS NULL` UPDATE guard (one transaction wins) and the partial unique index on `scheduled_messages` (catches any race that slips past application code) gives belt-and-suspenders dedup of the SMS schedule under concurrent Finalize clicks.

**`POST /api/drink-plans/:id/unfinalize`** (`auth`, `requireAdminOrManager`, `drinkPlanWriteLimiter`). Guard: `finalized_at IS NOT NULL`. Inside one transaction: (1) UPDATE `drink_plans` SET `finalized_at = NULL`, `finalized_by = NULL`. (2) UPDATE `shift_requests` SET `beo_acknowledged_at = NULL` for EVERY linked request (any status), not just approved. Stale acks on denied or pending rows would otherwise surface as "Confirmed [time]" pills on the admin EventDetailPage for any staffer who was once approved-and-acked, then denied, between Finalize cycles. Clearing all rows keeps the admin view honest. (3) UPDATE `scheduled_messages` SET `status = 'suppressed'`, `error_message = 'unfinalized: BEO unfinalized by admin'` WHERE `entity_type = 'proposal'` AND `entity_id = :proposalId` AND `message_type = 'beo_unack_nudge_sms'` AND `status = 'pending'`. Sent rows are deliberately left in place to preserve the audit trail. (4) INSERT into `proposal_activity_log` with `action = 'beo_unfinalized'`. COMMIT. Returns the updated plan.

The audit-preserving suppression in step 3 means a future Refinalize must use a status-aware idempotency check that ignores `status='suppressed'` rows when deciding whether to insert (see 6.4).

**`PATCH /api/drink-plans/:id/status` guard (modification to existing route).** The existing route accepts the four-value whitelist `pending`, `draft`, `submitted`, `reviewed` (the inert legacy `exploration_saved` is intentionally excluded). Add a guard before the UPDATE: if `finalized_at IS NOT NULL`, throw a 409 with `"Plan is finalized. Unfinalize first to change status."` regardless of the target status. This preserves the invariant that finalized plans are fully locked: no change to draft, no re-flag to submitted, no re-flag to reviewed. Reverting must go through the explicit Unfinalize endpoint, which knows to clear acks and suppress nudges.

**`GET /api/beo/:proposalId`** (`auth`, `beoReadLimiter`). Returns a single JSON payload composing the BEO content (see 7). Authorization rule:
- Admin / manager: always allowed.
- Staff: allowed if the user has an `approved` `shift_requests` row on a non-cancelled shift whose `proposal_id` matches `:proposalId` (see section 9 for the exact SQL with the `s.status != 'cancelled'` guard).
- Otherwise: 403.

**Response shape.** The route is keyed by `proposalId`, not `drink_plan` id. `drink_plans` is post-deposit, so most pre-deposit events have no row. The response is always 200 with this shape when authorized:

```json
{
  "proposal": { "id": ..., "event_type": ..., "event_type_custom": ..., "event_date": ..., "event_start_time": ..., "event_timezone": ..., "event_location": ..., "guest_count": ..., "num_bars": ..., ... },
  "client": { "name": ..., "phone": ... },
  "drink_plan": null | { "id": ..., "token": ..., "status": ..., "finalized_at": ..., "selections": {...}, "consult_selections": {...}, "admin_notes": ..., ... },
  "shopping_list_status": null | "approved" | "pending_review",
  "addons": [...],
  "shift_requests": [{ "user_id": ..., "beo_acknowledged_at": ... }, ...],
  "viewer": { "is_admin": bool, "is_acknowledged": bool }
}
```

`drink_plan: null` is the "proposal exists but no drink_plan row yet" case (admin hasn't created one); the BEO page renders the empty-state card from 7.10. The endpoint never 404s for an authorized viewer; 404 is reserved for missing proposals (section 9). `viewer.is_acknowledged` is convenience-computed so the page does not have to scan `shift_requests` itself.

**`POST /api/beo/:proposalId/acknowledge`** (`auth`, `drinkPlanWriteLimiter`). Role check FIRST: if `req.user.role === 'admin'` OR `req.user.role === 'manager'`, return 200 `{ acknowledged: false }` immediately (admin/manager view-only acknowledgment is a no-op; no `shift_requests` row to stamp). Otherwise, stamp `shift_requests.beo_acknowledged_at = NOW()` for every approved `shift_requests` row that belongs to this user on any shift linked to this proposal where the linked drink plan is finalized, in a single atomic UPDATE...FROM:

```sql
UPDATE shift_requests sr
   SET beo_acknowledged_at = NOW()
  FROM shifts s
  JOIN drink_plans dp ON dp.proposal_id = s.proposal_id
 WHERE sr.shift_id = s.id
   AND s.proposal_id = $1
   AND sr.user_id = $2
   AND sr.status = 'approved'
   AND s.status != 'cancelled'
   AND dp.finalized_at IS NOT NULL
RETURNING sr.id, sr.shift_id, sr.beo_acknowledged_at
```

This collapses the "is finalized?", "is the shift live?", and "stamp" into one statement. A concurrent Unfinalize that flips `finalized_at` to NULL between a hypothetical SELECT and UPDATE cannot leave an orphan ack on an un-finalized plan; an approved request tied to a cancelled shift cannot be stamped either. If the UPDATE returns zero rows (plan not finalized, no approved request, or only cancelled shifts), respond 409 with the specific reason. Admin acknowledgment is a no-op (no `shift_requests` row); returns 200 with `{ acknowledged: false }`.

**Response shape.** Successful staff ack returns `{ acknowledged: true, beo_acknowledged_at: <iso>, request_ids: [<sr.id>, ...] }`. The UI uses the returned `beo_acknowledged_at` for the "Confirmed [date_time]" pill swap, which avoids a second-tab race where each tab would otherwise show a different client-local NOW. Failure returns `{ acknowledged: false, reason: 'not_finalized' | 'no_approved_shift' | 'cancelled_only' }` with status 409.

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

The five-minute buffer is small breathing room so a SMS does not fire in the same minute as the click (the dispatcher tick is every 5 minutes; postgres transaction visibility already prevents reading uncommitted rows, so the buffer is not the race guard). Keeps the late-finalize "I just clicked Finalize" feel less jarring.

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
| recipient staff has no `contractor_profiles.phone` (or it does not normalize to E.164) | `no_phone` (suppress, do NOT fail; a missing phone is an ops issue to fix on the profile, not a dispatcher Sentry event) |
| recipient staff `users.onboarding_status = 'deactivated'` | `user_deactivated`. The schedule-time filter (6.4 step 4) only catches staffers deactivated BEFORE Finalize; a staffer assigned + approved while active, then deactivated AFTER Finalize but BEFORE the T-3 dispatch, slips past unless the dispatch-time gate catches it |
| event start (computed from proposal `event_date` + `event_start_time` + `event_timezone`) is in the past | `event_in_past` (covers the case where the event was rescheduled into the past after the row was scheduled; complements the scheduling-time guard in 6.4) |
| proposal `event_start_time` is NULL or unparseable (TBD-time event) | `no_start_time`. Existing routes tolerate `event_start_time` as NULL or "TBD" (`shifts.js:730` fallback); without this gate the past-event computation would throw and the row would land `failed` with a Sentry alert instead of clean suppression. At Finalize time, the same TBD condition causes `scheduleBeoNudgesForProposal` to skip the insert entirely (no point scheduling a nudge that will only fire to suppress); admin re-finalizes after setting the start time |
| `proposals.status='archived'` | not reached here; `checkSuppression` already catches it earlier in `dispatchRow` |

**Context loading.** The dispatcher's `lookupEntity('proposal', ...)` projects only `event_date` and `event_timezone`, NOT `event_start_time` or `event_duration_hours`. The BEO handler therefore does its own SELECT in a new `loadBeoContext(proposalId, userId)` helper rather than relying on the dispatcher-supplied `entity` for timing math. The helper fetches the proposal timing fields, the user's `contractor_profiles.phone`, the proposal/drink_plan join (for `finalized_at`), and the user's approved shift_requests for this proposal (for the staffer_unassigned and already_acknowledged gates) in a single round trip. This intentionally diverges from `loadStaffShiftContext` (shift-scoped) because BEO is proposal-scoped.

If all gates pass, the handler renders the SMS body via `smsTemplates.staffBeoNudgeSms` and sends through `sendAndLogSms`.

**SMS body** (no em dashes, neutral tone, mirrors the existing staff SMS voice):

```
BEO ready from Dr. Bartender: [event_type_label] on [event_date_local]. Tap to review and confirm: [staff_beo_url]
```

`[event_date_local]` is formatted via `staffShiftHandlers.formatEventDateLong` for cross-SMS consistency ("Saturday, August 15" in event TZ). `[event_type_label]` is `getEventTypeLabel(...)` truncated at 40 characters with an ellipsis if longer; `event_type_custom` is a free-text `VARCHAR(255)` and a long custom value (`"My Daughter's Sweet Sixteen Quinceañera Co-Birthday Celebration"`) would silently blow the 160-char segment budget. The truncation lives in the template (`smsTemplates.staffBeoNudgeSms`), not in the data, so the BEO page itself still renders the full label. `[staff_beo_url]` is `${STAFF_URL}/events/${proposalId}/beo`. The CTA is "tap and confirm in the portal." The SMS does NOT instruct the staffer to reply (reusing the existing `CONFIRM` keyword would steal it from the shift-ack flow, which is the existing established behavior).

**Length budget.** Worst-case body for a long event type ("graduation-celebration") runs ~120 characters before the URL, then `https://staff.drbartender.com/events/99999/beo` adds ~46 characters → ~166 characters total. This crosses the 160-character single-segment boundary and bills as 2 segments. Two acceptable mitigations: (a) accept 2-segment billing for BEO (volume is low; 1 nudge per event per staffer at most), or (b) shorten the body to `BEO ready: [event_type_label] on [event_date_local]. Tap to confirm: [url]` to keep ~140 characters typical. Pick (a) for v1; the URL itself eats most of the budget and any URL shortener adds infra. Re-evaluate if SMS spend becomes a line item.

### 6.4 Scheduling rows

Two scheduling moments. Both use a new `insertBeoNudgeIfMissing` helper (NOT the existing `insertShiftMessageIfMissing`, because that one is status-agnostic and would block re-insertion after Unfinalize suppresses a row; see below).

**On Finalize (`server/routes/drinkPlans.js`, finalize handler).** Inside the same transaction as the UPDATE that stamps `finalized_at`, call `scheduleBeoNudgesForProposal(proposalId, txClient)` (in `server/utils/beoHandlers.js`). **Every internal query inside the helper uses the passed `executor`, not the module-level pool.** Without this discipline the helper's pre-INSERT existence SELECT could read pre-transaction state and the "belt-and-suspenders" race-safety claim breaks. The helper:

1. Loads the proposal's `event_date`, `event_start_time`, `event_duration_hours`, `event_timezone` via `executor.query(...)`.
2. Computes `eventStartUtc` via `computeEventStartUtc(...)`. If `event_start_time` is NULL or `computeEventStartUtc` returns null (TBD-time event), **return without inserting**: skip BEO scheduling entirely. The Finalize endpoint still succeeds and stamps `finalized_at`; admin re-finalizes once the start time is set (Refinalize after Unfinalize semantics from 6.2 cover this case). If `eventStartUtc < NOW()`, **return without inserting**. We never schedule a BEO nudge for a past or TBD-time event.
3. Computes `scheduledFor = MAX(eventStartUtc - 3 days, NOW() + 5 minutes)`.
4. Selects DISTINCT `user_id` (also via `executor.query(...)`) across every approved `shift_requests` row on every non-cancelled shift linked to this proposal where `users.onboarding_status != 'deactivated'`. One row per staffer, even if the staffer is on two shifts.
5. For each `user_id`, calls `insertBeoNudgeIfMissing(executor, { proposalId, userId, scheduledFor })`. The helper's internal SELECT-then-INSERT both run on `executor`. Inserts a `scheduled_messages` row with `entity_type='proposal'`, `entity_id=proposalId`, `message_type='beo_unack_nudge_sms'`, `recipient_type='staff'`, `recipient_id=user_id`, `channel='sms'`, `scheduled_for=...`.

`insertBeoNudgeIfMissing` is status-aware AND race-safe: it SELECTs for an existing row on the natural key with `status IN ('pending','sent')`. If one exists, skip. If only `suppressed` or `failed` rows exist, proceed to INSERT with `ON CONFLICT (entity_id, entity_type, message_type, recipient_id, recipient_type, channel) WHERE status='pending' DO NOTHING` using the existing partial unique index (see 6.1). This is the crucial difference from `insertShiftMessageIfMissing` and is what makes the Unfinalize-then-Finalize loop work cleanly: the previous run's pending rows became `suppressed` on Unfinalize, so they no longer block re-insertion, but `sent` rows from earlier dispatches still block.

The **primary** double-Finalize protection is the Finalize-time `finalized_at IS NULL` UPDATE guard (section 6.2): only one transaction wins and only one transaction calls `scheduleBeoNudgesForProposal`. The partial unique index is **secondary**: it dedupes within the brief window where the partial index considers only pending rows (a fresh insert against a just-suppressed row could otherwise slip through, since the suppressed row falls outside the partial index). Belt-and-suspenders, but the belt is the UPDATE guard; the suspenders are the index.

**Deactivated staff filter.** The DISTINCT-user SELECT in step 4 joins `users u ON u.id = sr.user_id` and adds `AND u.onboarding_status != 'deactivated'`. A staffer whose account is deactivated keeps approved shift_requests historically but should not receive new nudges; without the filter, the dispatch-time gate has no condition for "user deactivated" and the SMS would fire.

**Transaction divergence flag.** Existing `scheduleStaffShiftMessages` is best-effort with its own try/catch + Sentry; failures do not roll back the caller. BEO scheduling is deliberately stricter: a scheduling failure inside Finalize rolls back the whole transaction. This is intentional (a Finalize without nudges fails its core promise) and worth keeping; do not "fix" the inconsistency.

The acknowledgment reset on Unfinalize is what guarantees a "fresh acknowledgment is needed" situation also gets a fresh nudge in practice: when admin Unfinalizes intending to push a re-ack, they must `Finalize` again, and between the two clicks any in-flight pending rows have been suppressed. If a sent row from a prior finalize cycle blocks a new pending insert, that's the rare case where admin should bump the nudge manually (out of scope for v1; the admin can re-send via the dispatcher's manual-retry path if needed).

Best-effort wrapping: `scheduleBeoNudgesForProposal` is called inside the Finalize transaction, so a scheduling failure rolls the whole Finalize back. This is intentional: a Finalize without nudges is a Finalize that silently fails its core promise. Errors propagate; the route returns 5xx and the admin retries.

**On fresh shift assignment (`server/utils/staffShiftHandlers.js`, in `scheduleStaffShiftMessages`).** The existing query joins `shifts` to `proposals` but NOT `drink_plans`. Add a `LEFT JOIN drink_plans dp ON dp.proposal_id = p.id` and SELECT `dp.finalized_at`. After the existing `shift_reminder` and `staff_thank_you` insert block, add a branch: if `dp.finalized_at IS NOT NULL` AND the just-approved staffer does NOT already have a BEO nudge row for this proposal (the natural-key check), call `insertBeoNudgeIfMissing` for the staffer.

This covers the "BEO was finalized weeks ago, admin assigns a staffer late" case without a new call site, because `scheduleStaffShiftMessages` is already invoked whenever a `shift_request` is approved (`server/routes/shifts.js` handlers).

**On reschedule.** The existing reanchor cascade (`staffShiftHandlers.reanchorStaffShiftMessages` called from `runRescheduleStaffHooks` in the proposals PATCH path) only fires when `shouldSendRescheduleEmail === true`, which itself depends on `hasReschedulableChange` (`rescheduleProposal.js:41`) covering `event_date`, `event_start_time`, AND `event_location`. The status-gate `POST_SIGNPAY` (`['deposit_paid', 'balance_paid', 'confirmed', 'completed']`, `rescheduleProposal.js:388`) also has to be true.

Practically, a finalized BEO always implies the proposal is deposit_paid or later (drink plans only unlock post-deposit per project memory), so the `POST_SIGNPAY` gate covers every finalized BEO case in practice.

The BEO reanchor therefore runs **inside `rescheduleProposalInTx`**, on the same `dbClient` as the proposal UPDATE and the existing `reanchorPendingMessages` offset cascade. Co-locating it preserves the atomicity that `rescheduleProposalInTx` exists to provide: proposal UPDATE + offset cascade + BEO reanchor all commit together, or all roll back together. A post-commit BEO reanchor would re-open the exact bug class Gemini already flagged for the offset cascade.

Inside `rescheduleProposalInTx`, after the existing per-shift reanchor loop:

1. Trigger condition: ANY change to `event_date` or `event_start_time` (the only fields the BEO anchor depends on; `event_location` is BEO content but doesn't move the anchor, `event_duration_hours` only affects END-anchored handlers like staff_thank_you, and `event_timezone` is not API-mutable per the existing PATCH route's accepted-field list and the column's NOT NULL DEFAULT).
2. Guard: `if (proposal.status === 'archived') skip;`.
3. Compute `new_event_start_utc`. If null/unparseable (TBD-time event), skip.
4. If `new_event_start_utc < NOW()`, skip the UPDATE; the row stays pending with its OLD `scheduled_for` (which becomes past at the next dispatcher tick if it wasn't already), the dispatcher picks it up, and the handler's `event_in_past` gate (6.3) suppresses it. Net effect: one extra dispatcher cycle to terminal-state the row, no SMS sent.
5. Single UPDATE on the dbClient: `scheduled_messages SET scheduled_for = MAX(new_event_start_utc - 3 days, NOW() + 5 minutes) WHERE entity_type='proposal' AND entity_id=proposalId AND message_type='beo_unack_nudge_sms' AND status='pending'`.

The "no BEO rows yet because Finalize hasn't been clicked" case is a no-op: the UPDATE matches zero rows.

The new function in `beoHandlers.js` is `reanchorBeoForProposal(proposalId, executor)`, taking the dbClient. `rescheduleProposalInTx` calls it; no separate post-commit hook exists.

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
| Admin Unfinalize | pending → `status='suppressed'`, `error_message='unfinalized: BEO unfinalized by admin'`; sent rows preserved | Inside the Unfinalize endpoint (section 6.2) |
| Proposal archived | `status='suppressed'`, reason `archived: ...` | Dispatcher `checkSuppression` (already covers `entity_type='proposal'` at `scheduledMessageDispatcher.js:124`) |
| Shift cancellation OR staffer unassignment via `cancel-or-unassign` | pending → `status='suppressed'`, reason `staffer_unassigned: ...`, **only when the staffer has no other approved active shifts on this proposal** | New code in `server/routes/shifts.js` cancel-or-unassign handler (see below). The existing `entity_type='shift'` UPDATE at `shifts.js:537` and `:553` is hardcoded to `shift_reminder`/`staff_thank_you`; that path does NOT cover BEO because the BEO row carries `entity_type='proposal'`, not `'shift'` |
| Admin denial via `PUT /api/shifts/requests/:requestId` (approved → denied) | pending → `status='suppressed'`, reason `staffer_unassigned: ...`, **only when the staffer has no other approved active shifts on this proposal**; AND clear that staffer's `beo_acknowledged_at` on the denied row | New code in the PUT route's deny branch (see below) |
| Admin hard-delete via `DELETE /api/shifts/:id` (shifts.js:479) | pending → `status='suppressed'`, reason `staffer_unassigned: shift deleted`, **only when the affected staffer has no other approved active shifts on this proposal** | New code in the DELETE handler before the existing cascade (see below). Without this, the row survives the cascade (BEO rows are scoped by `proposal_id`, not the deleted `shift_id`) and only the dispatch-time gate would catch it, relying on luck instead of explicit suppression |
| Generic admin shift-cancel via `PUT /api/shifts/:id` with `status='cancelled'` (shifts.js:419) | pending → `status='suppressed'`, reason `staffer_unassigned: shift cancelled (generic PUT)`, **only when each affected staffer has no other approved active shifts on this proposal** | New code in the PUT handler when the body sets `status='cancelled'`. The existing per-handler suppression at cancel-or-unassign does NOT cover this path; the generic PUT bypasses it. Same `NOT EXISTS`-guarded UPDATE applied per affected user |
| Staff or admin hard-delete of a request via `DELETE /api/shifts/requests/:requestId` (shifts.js:316) | pending → `status='suppressed'`, reason `staffer_unassigned: request deleted` for the request's user on the linked proposal, **only when the user has no other approved active shifts on this proposal**. Also clear that user's `beo_acknowledged_at` for the proposal (defensive; the request is gone, but historical rows on other requests carry the ack forward) | New code in the DELETE handler before the row is deleted. Capture `user_id` and `shift.proposal_id` first |
| `shift_requests.beo_acknowledged_at IS NOT NULL` at dispatch | `status='suppressed'`, reason `already_acknowledged: ...` | Handler throws `SuppressMessageError` (section 6.3) |
| `finalized_at IS NULL` at dispatch (defensive) | `status='suppressed'`, reason `beo_not_finalized: ...` | Handler throws `SuppressMessageError` |
| event start in the past at dispatch | `status='suppressed'`, reason `event_in_past: ...` | Handler throws `SuppressMessageError` |
| recipient staff has no phone | `status='suppressed'`, reason `no_phone: ...` | Handler throws `SuppressMessageError` |

The `<reason>: <freeform>` shape matches the existing dispatcher style (see the `archived: linked proposal is archived, cascade rule applies` message in `scheduledMessageDispatcher.js:139`). For dashboard / log greppability.

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

This guard assumes one shift mutation per handler call (the canonical pattern: one shift cancelled, one staffer unassigned, one request denied). If a future batch endpoint cancels multiple shifts in one transaction, the subquery would not see the in-progress cancellations within the same UPDATE and could leave a stale `approved` row counting against the suppression. Out of scope for v1; flag if any batch-cancel surface lands.

**Acknowledgment reset on re-approval / request reset.** Whenever a `shift_requests` row transitions to (or is created at) `approved` or `pending`, clear any stale `beo_acknowledged_at`. Three paths need the column reset:

- `POST /api/shifts/:id/assign` (admin-initiated assign / re-approve): add `beo_acknowledged_at = NULL` to the existing `ON CONFLICT (shift_id, user_id) DO UPDATE` clause.
- `PUT /api/shifts/requests/:requestId` approve branch (denied → approved): the route does a bare `UPDATE shift_requests SET status='approved' WHERE id=$1`, NOT an upsert. Add `beo_acknowledged_at = NULL` to that UPDATE's SET clause.
- `POST /api/shifts/:id/request` (staff-self-request, shifts.js:279): the route is `INSERT ... ON CONFLICT (shift_id, user_id) DO UPDATE SET status='pending'`. Add `beo_acknowledged_at = NULL` to the DO UPDATE for consistency (a previously-denied row going back to pending should not carry the ack; harmless until admin re-approves, but the assign/PUT approve branches both clear so this one should too for symmetry).

Without these, a staffer who was denied (with their pre-deny ack still on the row) and then re-approved would carry that stale ack forward and the dispatch-time `already_acknowledged` gate would skip the new nudge they actually need. Pattern:

```sql
ON CONFLICT (shift_id, user_id) DO UPDATE
  SET status = EXCLUDED.status,
      beo_acknowledged_at = NULL,   -- clear stale ack on re-approve or re-request
      ...
```

This pairs with the cancellation-suppression: cancelling a shift suppresses pending BEO rows; re-approving the staffer (potentially on another shift in the same proposal) clears their ack so the next Finalize cycle's nudge fires correctly.

**PUT /api/shifts/requests/:requestId deny path.** Before the UPDATE that flips `status='denied'`, SELECT the request's `user_id` and the shift's `proposal_id`. After the UPDATE, run two operations:
1. The same `NOT EXISTS`-guarded BEO suppression UPDATE as the cancel-or-unassign path, scoped to this user on this proposal.
2. Clear `beo_acknowledged_at` on the denied row itself, so a future re-approval starts clean (consistent with the assign / re-approve pattern).

**DELETE /api/shifts/:id (hard delete).** Wrap the three-step capture-delete-suppress sequence in `BEGIN/COMMIT/ROLLBACK` on a single `pool.connect()` client (the existing handler is a single statement; the spec adds two more, all three must commit together). Inside the transaction: SELECT the affected `user_id`s and the linked `proposal_id` first, then DELETE the shift (cascade removes `shift_requests`), then run the same `NOT EXISTS`-guarded BEO suppression UPDATE for each affected user. The `NOT EXISTS` subquery correctly sees the shift gone and suppresses for any staffer who had only that one shift on the proposal. Explicit suppression here means we are not relying on the dispatch-time `staffer_unassigned` gate to catch the orphan; it would catch it, but a system that depends on lucky cleanup is fragile, and a crash between the bare DELETE and a separate-statement suppression would leave the orphan row to fire.

### 6.7 Staff portal discovery

Two additions outside the BEO page itself so staff can find it.

**`client/src/pages/staff/StaffShifts.js`.** Today the card shows the event header, date, time, setup time, location, positions, and the request / status block. Add a small inline "View BEO" badge + link, gated to render ONLY when (a) this staffer's `shift_requests.status === 'approved'` for this shift AND (b) the shift itself is not `cancelled` (mirrors the auth guard in section 9). (The page lists shifts available for request too; an unapproved staffer or a staffer assigned to a cancelled shift clicking "View BEO" would hit the 403 from the auth check.) State badge values:

- `Draft` (drink plan exists, not yet `submitted` / `reviewed`)
- `Ready` (drink plan finalized, staffer has not acked)
- `Confirmed` (`beo_acknowledged_at IS NOT NULL`)
- hide the badge entirely if the staffer is not approved on this shift, the shift is cancelled, or the drink plan does not yet exist

**`client/src/pages/staff/StaffEvents.js`.** Mirror the same badge / link in whatever row treatment that page uses today.

The badge color uses the existing palette: amber for `Ready` (action-required), green for `Confirmed`, muted for `Draft`. No new color tokens.

### 6.8 Consumer endpoints requiring projection updates

Cross-cutting consistency (CLAUDE.md): adding `drink_plans.finalized_at`, `finalized_by`, and `shift_requests.beo_acknowledged_at` requires updating every existing GET that the new UI surfaces consume. Five endpoints need projection / JOIN updates:

| Endpoint | Change | Consumer |
|---|---|---|
| `GET /api/drink-plans` (list) | SELECT `finalized_at` | Admin drink-plans dashboard table (can show finalized status without a per-row detail fetch) |
| `GET /api/drink-plans/:id` | SELECT `finalized_at`, `finalized_by` | `DrinkPlanCard` (Finalize / Unfinalize button gating, "Finalized [time]" readout) |
| `GET /api/drink-plans/by-proposal/:proposalId` | SELECT `finalized_at`, `finalized_by` | Same |
| `GET /api/shifts/by-proposal/:proposalId` | When projecting `approved_staff` (today an array of name strings via `array_agg(... ORDER BY ...)`), switch to `json_agg(json_build_object('user_id', sr.user_id, 'name', ..., 'beo_acknowledged_at', sr.beo_acknowledged_at) ORDER BY <same key as today>)`. Keep the ORDER BY inside the aggregate or the admin UI sees random order | Admin EventDetailPage per-staffer "Confirmed [time]" pill |
| `GET /api/shifts` (staff path) | LEFT JOIN `drink_plans dp ON dp.proposal_id = s.proposal_id`, SELECT `dp.finalized_at`, plus the requester's `sr.beo_acknowledged_at` | StaffShifts View BEO badge state |
| `GET /api/shifts/user/:userId/events` | Same as above | StaffEvents View BEO badge state |

**Frontend consumer changes that fall out of the new data shapes.** `EventDetailPage.js` currently does `approved_staff.join(', ')` to render the staff list. Once that field becomes an array of objects, the join would render `[object Object]`. The page must map the array, rendering both each staffer's name and a Confirmed-or-Not-opened pill. This change is part of section 10 Files; it is called out here so the cross-cutting consumer audit is complete.

The exact column lists in each endpoint are an implementation-plan detail; the spec's contract is: every UI element that conditionally renders on `finalized_at` or `beo_acknowledged_at` has the data it needs without a second round trip, and every existing UI element that renders the data being reshaped is updated to handle the new shape.

## 7. BEO page content

`client/src/pages/staff/StaffBeo.js` renders the BEO. Mobile-first; this is bartender-in-the-parking-lot reading. Each section is a `card`.

### 7.1 Event header

- Client name plus a `tel:` link to client phone (intentional: bartender on-site may need to reach the client directly for last-minute coordination; matches existing exposure via the `shift_reminder` SMS body and the `GET /shifts` admin-facing data)
- Event type label (via `getEventTypeLabel`)
- Date in event timezone, formatted "Saturday, August 15"
- Start time, end time, and setup arrival time (use `setupTimeDisplay(proposal, pkg)` from `server/utils/setupTime.js`; do NOT hand-roll `event_start_time` minus a constant default, because the canonical helper applies hosted's 90-minute default and BYOB's 60-minute default correctly). All in event TZ
- Address (`event_location`) with a tap-to-open maps link
- Guest count, package name

### 7.2 Service plan

- Service style label (full bar / signatures / beer-wine / mocktail / custom-setup; derived from `drink_plans.serving_type` with friendly labels)
- Bar count: `proposals.num_bars`
- Bartender count: the **effective** count, not the raw `proposals.num_bartenders` column. The column is an admin OVERRIDE and is NULL for events without one; the effective count derives from `staffing.required` in `server/utils/pricingEngine.js`, or from `pricing_snapshot.staffing.required` if a snapshot exists. Rendering raw `num_bartenders` shows blank for most events
- For hosted packages, a one-line note that bartenders are included in the package up to a 1:100 ratio (consistent with `isHostedPackage` rule, just informational)

### 7.3 Drink menu

- Signature cocktails: name plus ingredient list, resolved from `cocktails` table by ID. If a referenced cocktail row has been deleted (the `drink_plans.selections.signatureDrinks` IDs are not FK-protected), render a small `Missing drink ([id])` placeholder rather than silently dropping the row, so the bartender notices and can ask. (Existing `shoppingListGen.js` silently drops; the BEO is a higher-stakes surface and bartenders need to know.)
- Mocktails: name plus ingredient list, resolved from `mocktails`. Same missing-row handling as above
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

If `selections.menuStyle` is `custom` or `house`: a card with `menuTheme`, `drinkNaming`, `menuDesignNotes`, and the uploaded logo (if `selections.companyLogo` is present, render via the existing token-gated `/api/drink-plans/t/:token/logo` proxy URL). The `drink_plan.token` is included in the GET BEO response payload (section 6.2) so the staff page can construct that URL. The token-gated logo proxy is public-by-design (the token is the auth); ensure the BEO renderer does NOT also expose the token in `tel:`, `mailto:`, or other visible-link attributes anywhere else on the page. Otherwise omit this card.

### 7.7 Special notes

Two distinct sources, clearly labeled in the UI:

- **Admin notes**: `drink_plans.admin_notes` (Dr. Bartender's internal prep notes)
- **From the client**: `selections.additionalNotes` (the catch-all "anything else?" textarea the client filled on the planner)

Both render as plain text with CSS `white-space: pre-line` so newlines are preserved (admin notes are often multi-paragraph; without `pre-line` the BEO renders a wall of text). No rich text. If both are empty, omit the card.

### 7.7.1 Consult input (admin-filled)

`drink_plans.consult_selections JSONB` holds the admin-only consult-form data (filled by admin via the "Input from consult" button on `DrinkPlanCard`). When present and non-empty, render a card titled "From consult" with the fields that are populated. The canonical key list and human-readable labels live in `client/src/components/ShoppingList/ConsultationForm.jsx` (the form's field definitions); reuse those labels in the BEO renderer rather than rendering raw JSON keys (`signatureDrinks`, `customCocktails`) which would be opaque to bartenders. If a key in `consult_selections` has no matching label in the form's definitions, fall back to a title-cased version of the key. Skip the card entirely when `consult_selections` is null or `{}`.

This is the bartender's most prep-relevant context (admin's notes from the planning call). Section 5 lists it as part of "additional bartender context"; rendering it here makes that real.

### 7.8 Shopping list link

If `shopping_list_status = 'approved'`: a "View shopping list" link to `${PUBLIC_SITE_URL}/shopping-list/${drink_plan_token}`. Hosted events skip this (admin is doing the shopping); the existing approval flow already gates the email send for hosted vs BYOB.

### 7.9 Confirm action bar

Sticky to the bottom of the viewport on the BEO page. CSS uses `padding-bottom: env(safe-area-inset-bottom)` so the action bar clears the iOS Safari home indicator gesture area (without it, the button sits under the gesture bar and is clipped or harder to tap).

- Drink plan not yet `finalized_at`: muted banner `"BEO still being prepped. Check back closer to the event."` No button.
- Drink plan finalized, this staffer has not acked: amber primary button `"Confirm I've read this BEO"`.
- Already acked: green pill `"Confirmed on [date and time]"`. No button.
- User is admin (no `shift_request` row): info pill `"You are viewing this as admin"`. No button.

### 7.10 Page-level states

The whole-page render handles three states beyond the per-section omits in 7.4-7.7:

- **Loading.** While the GET fetches, render a skeleton (one header card placeholder + 3-4 body-card placeholders). Match the StaffShifts loading shape ("Loading shifts..." spinner + skeleton) for consistency. Do NOT render an empty document.
- **Empty.** If the proposal exists but no `drink_plans` row exists (admin has not yet generated the drink plan for the event), render a muted card with body `"No drink plan yet for this event. The BEO will populate once the plan is created."` plus the event header card from 7.1 so the staffer can still see when/where. No "Confirm" action bar in this state.
- **Error.** On 4xx/5xx from `GET /api/beo/:proposalId`: render a centered card with the error message (toast on transient errors, full-page error on 403 with body `"You are not assigned to this event."`). Include a "Retry" button that re-issues the GET. 401 hard-redirects to `/login?next=/events/:proposalId/beo`.

## 8. Edge cases

- **Late finalize.** Admin finalizes the day before the event. `scheduledFor = NOW() + 5 minutes`. The nudge fires within minutes; if the staffer happens to have already opened the BEO and confirmed via the portal in that gap, the handler's gate suppresses it.
- **Past-event finalize.** Admin finalizes for an event that has already started or finished (catching up on paperwork after the fact). `scheduleBeoNudgesForProposal` sees `eventStartUtc < NOW()` and returns without inserting. No SMS goes out for past events. The Finalize itself still succeeds and stamps `finalized_at`.
- **Late assignment.** Admin assigns a new staffer the day before the event, when the BEO has been finalized for weeks. `scheduleStaffShiftMessages` (now joining `drink_plans`) sees `finalized_at` set, and `insertBeoNudgeIfMissing` creates a fresh nudge scheduled for `MAX(event_start - 3 days, NOW() + 5 minutes)`. The new staffer gets nudged within minutes.
- **Unfinalize then Finalize again.** Unfinalize suppresses pending rows with `error_message='unfinalized'` and clears `beo_acknowledged_at` on every linked `shift_requests`. The next Finalize calls `scheduleBeoNudgesForProposal` which uses the status-aware `insertBeoNudgeIfMissing`: existing rows with `status='suppressed'` do NOT block a new pending insert, so a fresh nudge is scheduled. Sent rows from prior cycles DO still block re-insertion (the SELECT excludes `('pending','sent')` from "exists"). In v1 this case is unrecoverable through the BEO UI: if admin needs a specific staffer to be re-nudged after a sent row, admin texts or calls them directly. (No "force re-nudge" admin button in v1; flagged as a follow-up in section 14.)
- **STOPped staffer (sms_enabled=false).** The dispatcher's existing `checkSuppression` recognizes the user-side opt-out and suppresses the BEO nudge row before the handler runs. The admin EventDetailPage pill shows "Not opened" for these staffers exactly the same as a staffer who hasn't clicked yet, so admin has no signal to chase manually. Tri-state pill ("Opted out" / "Not opened" / "Confirmed [time]") is flagged as a follow-up in section 14.
- **Reschedule.** Event moves; the BEO branch inside `rescheduleProposalInTx` updates `scheduled_for` on pending BEO nudge rows (matched by `entity_type='proposal'`). If the new date is now past T-3, the next dispatcher tick fires the nudge. If the new event start is in the past, `reanchorBeoForProposal` skips the UPDATE; the row keeps its existing (now stale) `scheduled_for`. At the next dispatcher tick that timestamp is treated as overdue, the handler runs, and the `event_in_past` gate (6.3) flips the row to `suppressed`. Net effect: one extra dispatcher cycle to terminal-state the row, no SMS sent.
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

**Existence check before auth.** Before the role / shift-request check, SELECT `id FROM proposals WHERE id = $1 LIMIT 1`. If zero rows, throw `NotFoundError('Event not found.')` (404). This avoids leaking proposal existence to authenticated-but-unauthorized staff who could otherwise probe IDs and infer "this ID exists" from a 403 vs 404 response.

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
- `server/utils/errors.js`: add `SuppressMessageError` class with a `reason` property. Add a clear inline comment that it is NOT an `AppError` subclass on purpose (the dispatcher contract is internal; this error never surfaces to a client and must not be routed through the global error middleware that handles `AppError`). The comment exists to deter a future contributor from "fixing" the inconsistency.
- `server/utils/scheduledMessageDispatcher.js`: `require` the new `SuppressMessageError` from `./errors`. Extend the `try/catch` around `await handler(...)` to discriminate `SuppressMessageError` (mark row `status='suppressed'` with the error's `reason`, return). Document the contract at the handler-registration callsite.
- `server/routes/drinkPlans.js`: add POST `/:id/finalize` and POST `/:id/unfinalize` next to the existing status route. Each wraps its writes in `pool.connect()` + `BEGIN/COMMIT/ROLLBACK`. Update the existing `PATCH /:id/status` to refuse any status change when `finalized_at IS NOT NULL` (the lock-when-finalized invariant). Update the existing `GET /` (list), `GET /:id`, and `GET /by-proposal/:proposalId` to SELECT `finalized_at` (and `finalized_by` on detail routes).
- `server/routes/shifts.js`:
  - `POST /:id/cancel-or-unassign`: SELECT `proposal_id` at handler entry. Add the `beo_unack_nudge_sms` `NOT EXISTS`-guarded suppression UPDATE from section 6.6.
  - `POST /:id/assign`: add `beo_acknowledged_at = NULL` to the assign / re-approve `ON CONFLICT DO UPDATE` to clear stale acks.
  - `POST /:id/request` (staff-self-request, line 279): add `beo_acknowledged_at = NULL` to the `ON CONFLICT DO UPDATE` for consistency with the assign / approve paths.
  - `PUT /shifts/requests/:requestId`:
    - on the **deny** branch (status approved → denied), run the same BEO suppression UPDATE for that user on the shift's proposal AND clear `beo_acknowledged_at` on the denied row.
    - on the **approve** branch (status denied/pending → approved), explicitly add `beo_acknowledged_at = NULL` to the UPDATE's SET clause (the route does a bare UPDATE, not an upsert; the assign path's ON CONFLICT pattern doesn't apply here). Without this, a previously-denied staffer's stale ack carries forward and the dispatch-time gate skips their new nudge.
    - The existing call to `scheduleStaffShiftMessages` at line 790 already exists; ensure the new branch added to `scheduleStaffShiftMessages` (LEFT JOIN drink_plans + conditional BEO nudge insert) flows through both call sites.
  - `PUT /:id` (generic shift update, line 419): when the request body sets `status='cancelled'`, run the same `NOT EXISTS`-guarded BEO suppression UPDATE as cancel-or-unassign, scoped to every approved user on the shift. (The generic PUT bypasses cancel-or-unassign's per-handler suppression.)
  - `DELETE /:id`: wrap the new three-step sequence in `BEGIN/COMMIT/ROLLBACK` on a `pool.connect()` client. Before the cascade DELETE, capture every approved `user_id` on the shift + the linked `proposal_id`. DELETE the shift (cascades remove `shift_requests`). Run the `NOT EXISTS`-guarded BEO suppression UPDATE for each affected user. All three commit together.
  - `DELETE /requests/:requestId` (line 316): SELECT `user_id` and `shift.proposal_id` before the row is deleted. After the DELETE, run the same `NOT EXISTS`-guarded BEO suppression UPDATE for that user on that proposal, and clear any `beo_acknowledged_at` for that user on other surviving shift_requests rows for the proposal.
  - `GET /shifts/by-proposal/:proposalId`: switch `approved_staff` from `array_agg(name)` to `json_agg(json_build_object(..., 'beo_acknowledged_at', sr.beo_acknowledged_at) ORDER BY <same key>)`.
  - `GET /shifts` (staff path) + `GET /shifts/user/:userId/events`: LEFT JOIN `drink_plans` for `finalized_at`, plus the requester's `sr.beo_acknowledged_at`.

- `server/utils/staffShiftHandlers.js`: add `formatEventDateLong` to the module.exports list. The function is defined at line 349 but not currently exported; the BEO handler imports it for SMS-body date formatting. (Alternative: move the helper to a new shared util like `server/utils/eventTimeFormat.js` and import from both. Either works; export is the minimal-diff path.)
- `server/utils/smsTemplates.js`: add `staffBeoNudgeSms({ eventTypeLabel, eventDateLocal, beoUrl })`. SMS body keeps the word "confirm" deliberately: the goal is to drive staff to the portal where the click is itself the read-receipt signal.
- `server/utils/smsTemplates.test.js`: add the matching test cases (link present, no em dashes, expected phrasing).
- `server/utils/staffShiftHandlers.js`: extend `scheduleStaffShiftMessages` to LEFT JOIN `drink_plans` and conditionally enqueue the BEO nudge for the new staffer when the linked plan is finalized.
- `server/utils/beoHandlers.js` (new, already listed above): also exports `reanchorBeoForProposal(proposalId, executor)`. A single UPDATE on pending BEO rows for the proposal, run on the passed dbClient, guarded by `proposals.status != 'archived'` and skipping when `new_event_start_utc < NOW()` or `event_start_time` is NULL.
- `server/utils/rescheduleProposal.js`: extend `rescheduleProposalInTx` to invoke `reanchorBeoForProposal(proposalId, dbClient)` after the existing per-shift reanchor loop, gated on `event_date` or `event_start_time` having changed. The call runs in-transaction so the proposal UPDATE, the offset cascade, and the BEO reanchor commit together.
- `server/utils/staffShiftHandlers.test.js`: assignment-after-finalize, no-op when finalize hasn't happened yet.
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
- `client/src/pages/admin/EventDetailPage.js`: add the "View BEO" link near the DrinkPlanCard. The link points cross-domain to `${STAFF_URL}/events/${proposalId}/beo` (the BEO page route lives only in `StaffSiteRoutes` on `staff.drbartender.com`; admin navigates cross-domain). Use `target="_blank" rel="noopener"` so admin keeps their admin tab open. Admin must be logged into the staff portal for the page to render; that login is a separate session from the admin login. Replace `approved_staff.join(', ')` with a map over the new object array; render each staffer's name (falling back to `email` if `name` is null, then to "Staff member" if both are null) plus a `Confirmed [time]` / `Not opened` pill driven by `beo_acknowledged_at`.

### Docs (mandatory per CLAUDE.md)
- `README.md`: folder tree (new `beo.js` route, new `beoHandlers.js` util, new `StaffBeo.js` page); Key Features (add BEO surface line).
- `ARCHITECTURE.md`: route table (4 new rows for finalize / unfinalize / GET BEO / acknowledge); schema section (the three new columns); scheduled-message section (`beo_unack_nudge_sms`).
- `CLIENT_FACING_SURFACES.md`: not applicable (staff-facing, not client).

## 11. Testing approach

**Server unit tests** (node:test, real dev DB per existing pattern):

- `beoHandlers.test.js`:
  - `scheduleBeoNudgesForProposal` inserts ONE row per approved staffer per proposal (deduping across multiple shifts for the same staffer)
  - `scheduleBeoNudgesForProposal` skips cancelled shifts and un-approved requests
  - `scheduleBeoNudgesForProposal` skips staffers whose `users.onboarding_status='deactivated'`
  - `scheduleBeoNudgesForProposal` with late finalize (event in 1 day) collapses `scheduled_for` to `NOW + 5min`
  - `scheduleBeoNudgesForProposal` with a past-event finalize returns 0 inserts (the strict `eventStartUtc >= NOW()` guard)
  - `insertBeoNudgeIfMissing` allows re-insertion when only suppressed rows exist (Refinalize after Unfinalize)
  - `insertBeoNudgeIfMissing` blocks re-insertion when a sent or pending row exists
  - `suppressBeoNudgesForProposal` UPDATEs pending to suppressed with reason, leaves sent rows alone
  - `suppressBeoNudgesForStaffers` only suppresses when the staffer has no remaining approved active shifts on the proposal (the `NOT EXISTS` guard)
  - `reanchorBeoForProposal` updates pending row `scheduled_for` for any timing-field change
  - `reanchorBeoForProposal` skips on archived proposal
  - `reanchorBeoForProposal` skips UPDATE when `new_event_start_utc < NOW()` (relies on dispatch-time gate)
  - `handleBeoUnackNudge` throws `SuppressMessageError` for each gate: not finalized, already acked, unassigned, no_phone, event_in_past, no_start_time (one test per gate)
  - `handleBeoUnackNudge` loadBeoContext SELECT supplies event_start_time/event_duration_hours (not via dispatcher's lookupEntity)
  - `handleBeoUnackNudge` sends + logs SMS via `sendAndLogSms` when all gates pass
  - `scheduleBeoNudgesForProposal` returns zero inserts when `event_start_time IS NULL` (TBD-time event)
  - Dispatcher's `checkSuppression` (sms_enabled=false) suppresses BEO row before handler runs; does NOT route through `SuppressMessageError`

- `scheduledMessageDispatcher.test.js` additions:
  - A handler throwing `SuppressMessageError` results in the row being marked `status='suppressed'` with the error's `reason` in `error_message`
  - A handler throwing `SuppressMessageError` does NOT call `Sentry.captureException` (the discriminator runs BEFORE the failure path's Sentry call)
  - A handler throwing any other error still flows through the existing `status='failed'` path AND calls Sentry
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
  - `PUT /shifts/requests/:requestId` deny branch suppresses BEO nudge AND clears `beo_acknowledged_at` for that staffer
  - `PUT /shifts/requests/:requestId` approve branch (re-approval) clears `beo_acknowledged_at` (carry-forward guard)
  - `PUT /shifts/:id` with `status='cancelled'` suppresses BEO nudges for affected users with no other approved active shifts
  - `POST /shifts/:id/assign` re-approve clears `beo_acknowledged_at = NULL`
  - `POST /shifts/:id/request` (staff-self-request) ON CONFLICT clears `beo_acknowledged_at = NULL`
  - `DELETE /shifts/:id` suppresses BEO nudges for every previously-approved user on the deleted shift who has no other approved active shift on the proposal
  - `DELETE /shifts/requests/:requestId` suppresses BEO nudges and clears beo_acknowledged_at on surviving rows for the same user/proposal
  - auth check on `GET /api/beo/:proposalId` rejects a staffer whose only approved request is on a cancelled shift
  - auth check on `GET /api/beo/:proposalId` returns 404 (not 403) for a non-existent proposalId
  - Finalize refuses an archived proposal even when status='reviewed' (409)
  - GET `/shifts/by-proposal/:proposalId` projects `approved_staff` as an array of objects with `beo_acknowledged_at`, ORDER BY preserved
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

3. Extend the dispatcher's `dispatchRow` try/catch with a discriminator BEFORE the existing failure branch. The `instanceof SuppressMessageError` check MUST be the first statement inside the catch block, and MUST return without falling through. Order matters: the existing failure path calls `Sentry.captureException` and `console.error`; if those run before the discriminator, every legitimate suppression (already_acknowledged, staffer_unassigned, event_in_past, no_phone) would create a Sentry event and burn quota:

```js
try {
  await handler({ entity, recipient, scheduledMessage: row });
  await pool.query(
    "UPDATE scheduled_messages SET status='sent', sent_at=NOW(), error_message=NULL WHERE id=$1",
    [row.id]
  );
} catch (err) {
  // SuppressMessageError must be handled FIRST, before any Sentry / console call.
  // Suppressions are expected dispatch outcomes, not failures.
  if (err instanceof SuppressMessageError) {
    const cappedReason = String(err.reason || '').slice(0, 500);   // mirrors existing 500-char cap on error_message writes
    await pool.query(
      "UPDATE scheduled_messages SET status='suppressed', error_message=$2 WHERE id=$1",
      [row.id, cappedReason]
    );
    return;
  }
  // existing failure path unchanged (Sentry.captureException + console.error + status='failed')
  ...
}
```

4. Handlers (BEO is the first) throw `new SuppressMessageError('reason')` for any expected gate failure. Unexpected failures (DB unreachable, null pointer) continue to throw normally and flow through the existing `failed` path with Sentry.

**Contract: only handlers may throw `SuppressMessageError`.** The dispatcher's `dispatchRow` try/catch wraps not just `handler(...)` but also the stale-pending check, `lookupEntity`, `lookupRecipient`, `checkSuppression`, `resolveDelivery`, and the overlap-defer logic. If any of those helpers ever started throwing `SuppressMessageError`, the discriminator would silently mask what should remain a `failed` row (and would silently suppress the actual delivery). Add an inline comment at the discriminator stating this rule so a future contributor doesn't accidentally extend the type to lookup helpers.

This is the only viable pattern given the existing dispatcher contract. The same `SuppressMessageError` is available to any future handler that needs the third outcome.

## 13. Risk and rollback

- **Schema additions are additive and nullable.** Rollback = `ALTER TABLE ... DROP COLUMN`. Index is small.
- **Notification handler is best-effort at the row level.** Suppression and failure are isolated; a single bad row never affects the rest of the dispatcher queue.
- **No money path involvement.** No pricing logic, no Stripe, no invoice mutation.
- **`entity_type='proposal'` is load-bearing for dedup.** Per-proposal-per-staffer is what makes the multi-shift case produce one SMS instead of N. Any future change that scopes BEO rows to `entity_type='shift'` would re-introduce the duplicate-nudge bug and would invalidate the suppression matrix in 6.6. Flag this in any spec that touches the BEO dispatcher contract.
- **Worst-case bug:** a NUDGE BLAST. The partial unique index plus the application-level dedupe make true duplicate-row inserts effectively impossible. The realistic worst case is the dispatcher tick interval shortening AND the `SuppressMessageError` discriminator misbehaving, with already-acked staffers re-SMSed every tick until admin intervenes. Mitigation: the dispatcher's batch-size cap (`MAX_BATCH`) caps blast radius per tick at the existing limit; admin can disable schedulers via `RUN_SCHEDULERS=false` env (per CLAUDE.md) to stop the bleed.
- **DELETE proposal cascades cleanly.** The existing `DELETE /api/proposals/:id` route already runs `DELETE FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1` in the same transaction as the proposal delete (`crud.js:741`), so BEO rows are correctly cascaded with no new code needed.

**Observability.** Finalize / Unfinalize / Acknowledge each emit one `console.log` line with proposal_id, the count of nudge rows scheduled or suppressed, and (for Finalize) the anchor time. Matches the verbosity of `[shoppingListReady]` / `[drinkPlanSubmit]` / `[BalanceScheduler]` for two-weeks-later debugging. The activity-log entries are the durable record; the console line is what helps with live debugging.

Add one more diagnostic line: when `handleConfirm` stamps `shift_requests.acknowledged_at` AND the staffer has a finalized-but-unacked BEO on the same proposal, log `[smsInbound] shift CONFIRM received with pending BEO ack (proposal_id=..., user_id=...)`. This surfaces the design's deliberate non-reroute (a staffer texting CONFIRM in response to the BEO nudge gets shift-ack, not BEO-ack) so it does not look like a mystery in real-world data.

Primary surfaces to watch in production: (1) the dispatcher's new `SuppressMessageError` ordering, because a regression there would silently flood Sentry OR convert legitimate failures to silent suppressions; (2) the cross-shift dedup via `entity_type='proposal'`, because regressing it would multiply SMS volume; (3) the PUT request deny path's BEO suppression, because skipping it would leak nudges to denied staffers; (4) the dispatcher tick interval, because shortening it surfaces the nudge-blast worst case above.

## 14. Out of scope / follow-ups

- Email channel for the nudge (defer; SMS-only ships; add if open rates demand it)
- BEO PDF export / print stylesheet
- Per-staffer ack channel column on `shift_requests` (defer; v1 just shows time)
- BEO version history (deferred; Unfinalize loop is the v1 escape hatch)
- Acknowledgment expiry (e.g., re-ack required if event > 30 days out and BEO changed). Out for v1.
- A "View BEO" link from the staff WhatsApp group flow. Out, not the right channel.
- **Force re-nudge admin button.** Section 8's "Unfinalize then Finalize again" edge case for a staffer with a prior sent row is unrecoverable in v1. A "Re-nudge this staffer" admin action on EventDetailPage that resets one row to pending would close the gap if it comes up in practice.
- **StaffLayout BEO badge.** A top-nav badge on the staff portal showing "BEO awaiting confirmation: N" would dramatically improve discovery; today staff must remember to visit StaffShifts/StaffEvents. One additional GET on layout mount, cached briefly. Out for v1 but cheap to add.
- **SMS spend threshold trigger.** Section 6.3 accepts 2-segment billing for the BEO nudge as the v1 mitigation. If monthly Twilio spend on `beo_unack_nudge_sms` ever exceeds a meaningful share of operational SMS spend, switch to mitigation (b) (shorter body) or add a URL shortener. Out for v1.
- **Tri-state ack pill on admin.** Today's pill is "Not opened" / "Confirmed [time]". Adding an "Opted out (SMS disabled)" state for STOPped staffers requires the admin endpoint to inspect the latest `scheduled_messages` row's `error_message` (or join `users.communication_preferences`). Useful but not blocking; surfaces an existing data gap (admin has no visibility today into staff SMS opt-out beyond the table) so worth a dedicated cut.
- **User-keyed `drinkPlanWriteLimiter` variant.** Today's limiter falls back to `req.ip` for non-token routes, which buckets all office admins together. Switch to user.id-keyed if admin volume grows or remote admins land on the same NAT.
- **Generic admin "BEO retry" surface.** Beyond the force-re-nudge case, an admin tool that lists all `scheduled_messages` with status filters would consolidate today's ad-hoc DB-poking. Deferred.
