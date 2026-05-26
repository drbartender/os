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
- **Confirm loop mirrors the existing shift ack** (`shift_requests.acknowledged_at` is the prior art). A new column `shift_requests.beo_acknowledged_at` is the BEO equivalent. Both the staff portal button and the inbound SMS `CONFIRM` keyword can stamp it.
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
  ADD COLUMN IF NOT EXISTS finalized_by INTEGER REFERENCES users(id);

ALTER TABLE shift_requests
  ADD COLUMN IF NOT EXISTS beo_acknowledged_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_drink_plans_finalized_at
  ON drink_plans(finalized_at) WHERE finalized_at IS NOT NULL;
```

`finalized_at` doubles as the boolean ("is this finalized?") and the timestamp for display. `finalized_by` traces who finalized for accountability. `beo_acknowledged_at` lives on `shift_requests` rather than `users` because acknowledgment is per-event-per-staffer.

The partial index on `finalized_at` keeps the index small (we only ever filter on the small finalized subset, never the unfinalized majority).

### 6.2 Routes

**`POST /api/drink-plans/:id/finalize`** (auth, admin-or-manager). Guard: `drink_plans.status = 'reviewed'`. Sets `finalized_at = NOW()`, `finalized_by = req.user.id`. Then schedules `beo_unack_nudge_sms` rows for each currently-approved staffer on each shift linked to the proposal (see 6.4). Logs to `proposal_activity_log` as `action = 'beo_finalized'`. Returns the updated plan.

**`POST /api/drink-plans/:id/unfinalize`** (auth, admin-or-manager). Guard: `finalized_at IS NOT NULL`. Clears `finalized_at` and `finalized_by` on the drink plan. Clears `beo_acknowledged_at` on every linked `shift_requests` row. DELETEs every `beo_unack_nudge_sms` row (pending or sent) for shifts linked to this proposal, so a future Refinalize starts clean against the existing status-agnostic `insertShiftMessageIfMissing` helper. Logs to `proposal_activity_log` as `action = 'beo_unfinalized'`. Returns the updated plan.

**`GET /api/beo/:proposalId`** (auth, staff or admin). Returns a single JSON payload composing the BEO content (see 7). Authorization rule:
- Admin / manager: always allowed.
- Staff: allowed if the user has an `approved` `shift_requests` row on a shift whose `proposal_id` matches `:proposalId`.
- Otherwise: 403.

**`POST /api/beo/:proposalId/acknowledge`** (auth, staff or admin). Guard: `drink_plans.finalized_at IS NOT NULL` for the linked plan. Stamps `shift_requests.beo_acknowledged_at = NOW()` for every approved `shift_requests` row that belongs to this user on any shift linked to this proposal. (A staffer who has been assigned to two shifts on the same proposal acknowledges both with one click.) Admin acknowledgment is a no-op (no shift_request row), returns 200 with `acknowledged: false`.

The finalize / unfinalize endpoints live in `server/routes/drinkPlans.js` (next to the existing status route). The BEO read and acknowledge endpoints live in a new `server/routes/beo.js` (mounted at `/api/beo`) so the BEO surface has its own clear module rather than bolting more onto `drinkPlans.js`.

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

`offsetFromEventDate: null` matches `shift_reminder` and `staff_thank_you`: the generic offset cascade skips it, and we re-anchor explicitly on reschedule (see 6.5).

**`scheduledFor` formula.** `MAX(event_start_utc - 3 days, NOW() + 5 minutes)`. The five-minute buffer prevents a finalize-then-immediate-dispatch race that could land before the row is fully committed.

**Pre-dispatch gate.** The handler's first action loads context and checks four conditions. If any fail, the handler marks its own row `status = 'suppressed'` with an `error_message` reason and returns without sending. No throw, no Sentry. The conditions:

| Condition | Reason marked on row |
|---|---|
| `drink_plans.finalized_at IS NULL` | `beo_not_finalized` (defensive: should not happen because Unfinalize DELETEs pending rows) |
| `shift_requests.beo_acknowledged_at IS NOT NULL` | `already_acknowledged` |
| `shift_requests.status != 'approved'` | `staffer_unassigned` |
| `proposals.status = 'archived'` OR `shifts.status = 'cancelled'` | `event_cancelled` |

If all gates pass, the handler renders the SMS body via `smsTemplates.staffBeoNudgeSms` and sends through `sendAndLogSms`.

**SMS body** (no em dashes, neutral tone, mirrors the existing staff SMS voice):

```
BEO ready from Dr. Bartender: [event_type_label] on [event_date_local]. Tap to review and confirm: [staff_beo_url]
```

`[staff_beo_url]` is `${STAFF_URL}/events/${proposalId}/beo`. We deep-link into the staff portal so the click-through itself is part of the confirm pattern. The portal page renders the BEO and exposes the "Confirm I've read this" button.

### 6.4 Scheduling rows

Two scheduling moments. Both reuse the existing `insertShiftMessageIfMissing` idempotency helper.

**On Finalize (`server/routes/drinkPlans.js`, finalize handler).** After the UPDATE that stamps `finalized_at`, call a new `scheduleBeoNudgesForProposal(proposalId, executor)` helper (in `server/utils/beoHandlers.js`). The helper:

1. Loads the proposal's `event_date`, `event_start_time`, `event_duration_hours`, `event_timezone`.
2. Computes `scheduledFor` via `MAX(computeEventStartUtc(...) - 3 days, NOW() + 5 minutes)`.
3. Selects every `(shift_id, user_id)` pair where the shift is linked to this proposal, the shift is not cancelled, and the shift_request is `approved`.
4. For each pair, inserts a `scheduled_messages` row with `entity_type='shift'`, `entity_id=shift_id`, `message_type='beo_unack_nudge_sms'`, `recipient_type='staff'`, `recipient_id=user_id`, `channel='sms'`, `scheduled_for=...`. Uses `insertShiftMessageIfMissing` so an Unfinalize-then-Finalize loop is idempotent.

Best-effort: wrap the call in a try / catch / Sentry. A scheduling failure must not block the finalize response.

**On fresh shift assignment (`server/utils/staffShiftHandlers.js`, in `scheduleStaffShiftMessages`).** After the existing `shift_reminder` and `staff_thank_you` rows insert, add a branch: if the linked drink plan has `finalized_at IS NOT NULL`, also insert a `beo_unack_nudge_sms` row for the new staffer. The existing call sites already invoke `scheduleStaffShiftMessages` whenever a `shift_request` is approved, so this covers the "BEO was finalized weeks ago, admin adds a staffer late" case without a new call site.

**On reschedule.** `staffShiftHandlers.reanchorStaffShiftMessages` already iterates linked shifts to update `shift_reminder` and `staff_thank_you` scheduled_for. Extend that loop to also update pending `beo_unack_nudge_sms` rows: recompute `MAX(new_event_start_utc - 3 days, NOW() + buffer)` and UPDATE `scheduled_for` for any pending row. Same idempotency contract.

### 6.5 Confirm loop

**Portal button.** The staff portal BEO page renders a sticky bottom-of-viewport action bar. When `finalized_at IS NOT NULL` and the user has at least one unacked approved `shift_request` on this proposal, the bar shows "Confirm I've read this BEO" as a primary button. Click POSTs `/api/beo/:proposalId/acknowledge`. On success: the bar swaps to a quiet "Confirmed [date_time]" pill. On failure: toast plus the button stays.

**SMS inbound CONFIRM.** Extend `server/utils/smsInbound.js`. New helper `findBeoUnackTarget(staffUserId)`:

```js
// SELECT sr.id AS request_id, s.id AS shift_id, s.proposal_id,
//        dp.finalized_at
//   FROM shift_requests sr
//   JOIN shifts s ON s.id = sr.shift_id
//   LEFT JOIN drink_plans dp ON dp.proposal_id = s.proposal_id
//  WHERE sr.user_id = $1
//    AND sr.status = 'approved'
//    AND sr.beo_acknowledged_at IS NULL
//    AND dp.finalized_at IS NOT NULL
//    AND s.event_date >= CURRENT_DATE
//    AND s.status NOT IN ('completed', 'cancelled')
//  ORDER BY s.event_date ASC, s.start_time ASC
//  LIMIT 1
```

In `processInboundSms`'s `code === 'confirm'` branch, call `findBeoUnackTarget(sender.staffUserId)` first.

- If it returns a row: stamp `beo_acknowledged_at = NOW()` on that `shift_requests` row (only that one; do not also touch `acknowledged_at`). Reply: `Confirmed from Dr. Bartender: BEO acknowledged for the [event_date_short] event. See you there.`
- If it returns nothing: fall through to the existing `handleConfirm(staffUserId)` path that stamps `acknowledged_at` on the nearest approved shift. Reply unchanged.

A staffer who has both a freshly assigned shift (un-acked) and a freshly finalized BEO (un-acked) and texts CONFIRM gets the BEO ack stamped, which is the more pressing of the two. The shift ack path remains untouched for everyone else.

**Admin acknowledgment view.** On the admin EventDetailPage, the staff-assignment block (existing) gains a small per-staffer pill: `Not opened` or `Confirmed [time]`. Data source: `shift_requests.beo_acknowledged_at`. V1 does not distinguish portal-confirmed from SMS-confirmed; that enrichment is a follow-up if the source channel turns out to matter for ops.

### 6.6 Suppression matrix

Single source of truth for what suppresses a BEO nudge row. Read top to bottom; first match wins.

| Trigger | Row state | When |
|---|---|---|
| Admin Unfinalize | row DELETEd entirely | Inside the Unfinalize endpoint, before the response returns |
| Shift cancellation (existing path) | `status='suppressed'` via existing `checkSuppression` | Dispatcher pre-flight (already implemented) |
| Proposal archived (existing path) | `status='suppressed'` via existing `checkSuppression` | Dispatcher pre-flight (already implemented) |
| Staffer unassigned (existing path) | `status='suppressed'` via existing path | Dispatcher pre-flight (already implemented) |
| `beo_acknowledged_at IS NOT NULL` at dispatch | `status='suppressed'`, reason `already_acknowledged` | Handler self-marks |
| `finalized_at IS NULL` at dispatch (defensive) | `status='suppressed'`, reason `beo_not_finalized` | Handler self-marks |

### 6.7 Staff portal discovery

Two additions outside the BEO page itself so staff can find it.

**`client/src/pages/staff/StaffShifts.js`.** Today the card shows the event header, date, time, setup time, location, positions, and the request / status block. Add a small inline status when the shift is on a proposal whose drink plan is finalized: a "View BEO" link (badge that opens the BEO page in the staff portal). State badge values:

- `Draft` (drink plan exists, not yet `submitted` / `reviewed`)
- `Ready` (drink plan finalized, staffer has not acked)
- `Confirmed` (`beo_acknowledged_at IS NOT NULL`)
- hide the badge entirely if the drink plan does not yet exist

**`client/src/pages/staff/StaffEvents.js`.** Mirror the same badge / link in whatever row treatment that page uses today.

The badge color uses the existing palette: amber for `Ready` (action-required), green for `Confirmed`, muted for `Draft`. No new color tokens.

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

- **Late finalize.** Admin finalizes the day before the event. `scheduledFor = NOW() + 5 minutes`. The nudge fires within minutes; if the staffer happens to have already opened the BEO and confirmed via the portal in that gap, the gate suppresses it.
- **Late assignment.** Admin assigns a new staffer the day before the event, when the BEO has been finalized for weeks. `scheduleStaffShiftMessages` sees `finalized_at` set, inserts a fresh nudge row, scheduled for `MAX(event_start - 3 days, NOW() + 5 minutes)` which collapses to "soon". The new staffer gets nudged within minutes.
- **Unfinalize then Finalize again.** The Unfinalize endpoint DELETEs all `beo_unack_nudge_sms` rows for the proposal's shifts and clears every linked `beo_acknowledged_at`. The next Finalize runs `scheduleBeoNudgesForProposal` against a clean slate; the existing status-agnostic `insertShiftMessageIfMissing` works as-is because no row exists for the natural key.
- **Reschedule.** Event moves; the existing reanchor loop updates `scheduled_for` on pending rows. If the new date is now past T-3, the next dispatcher tick fires the nudge.
- **Staffer texts CONFIRM but has no finalized BEO and no upcoming shift.** Existing path returns "no_shift" with the friendly reply.
- **Staffer texts CONFIRM, no BEO is finalized but they have an upcoming approved shift.** Existing `handleConfirm` runs unchanged; `acknowledged_at` is stamped. Same behavior as today.
- **Same proposal, two shifts for the same staffer.** `acknowledge` endpoint stamps both `shift_request` rows. SMS CONFIRM stamps the nearest one only; the second one persists as un-acked, and a second nudge fires for it. We accept this for v1: two-shift assignments to the same staffer on the same proposal are rare, and a second nudge is a tolerable nuisance.
- **Admin views the BEO.** No `shift_request`, no acknowledgment. Endpoint returns 200 with the BEO payload; the page shows the "viewing as admin" pill.
- **Drink plan finalized but never `reviewed`.** Cannot happen: the Finalize endpoint guards on `status='reviewed'`.
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
      LIMIT 1`,
    [proposalId, req.user.id]
  );
  if (!r.rowCount) throw new PermissionError('You are not assigned to this event.');
}
```

The frontend route `/events/:proposalId/beo` lives inside `StaffLayout`, which already requires login.

**The acknowledge endpoint** is gated identically. Admins call it as a no-op (no `shift_request` for them).

## 10. Files

### Server (new)
- `server/routes/beo.js`: GET `/api/beo/:proposalId`, POST `/api/beo/:proposalId/acknowledge`. Mounted in `server/index.js`.
- `server/utils/beoHandlers.js`: `scheduleBeoNudgesForProposal(proposalId, executor)`, `deleteBeoNudgesForProposal(proposalId, executor)`, `handleBeoUnackNudge` dispatcher handler, `registerBeoHandlers()` bootstrap.
- `server/utils/beoHandlers.test.js`: scheduling idempotency, gate evaluation, cancel-on-unfinalize, late-finalize collapse.
- `server/routes/beo.test.js`: authorization (staff with approved shift vs staff without; admin), acknowledge flow, content-shape smoke.

### Server (modify)
- `server/db/schema.sql`: the three idempotent ALTERs + the partial index from 6.1.
- `server/routes/drinkPlans.js`: add POST `/:id/finalize` and POST `/:id/unfinalize` next to the existing status route. Both wrap the DB write + nudge scheduling in a try / catch / Sentry.
- `server/utils/smsTemplates.js`: add `staffBeoNudgeSms({ eventTypeLabel, eventDateLocal, beoUrl })`.
- `server/utils/smsTemplates.test.js`: add the matching test cases (link present, no em dashes, expected phrasing).
- `server/utils/smsInbound.js`: extend `processInboundSms`'s `confirm` branch with the BEO-priority routing described in 6.5.
- `server/utils/smsInbound.test.js`: cover BEO-priority routing, fall-through to shift ack, the "neither" reply.
- `server/utils/staffShiftHandlers.js`: extend `scheduleStaffShiftMessages` to also enqueue the BEO nudge when the linked drink plan is finalized; extend `reanchorStaffShiftMessages` to update pending `beo_unack_nudge_sms` rows on reschedule.
- `server/utils/staffShiftHandlers.test.js`: assignment-after-finalize, reschedule re-anchor for BEO nudge.
- `server/index.js`: mount `/api/beo`, register `registerBeoHandlers()` in the scheduler-bootstrap block.

### Client (new)
- `client/src/pages/staff/StaffBeo.js`: the BEO viewer page.
- `client/src/pages/staff/StaffBeo.css`: scoped styles (cards, sticky action bar) if the existing classes need supplementing.

### Client (modify)
- `client/src/App.js`: add the `/events/:proposalId/beo` route under `StaffLayout`.
- `client/src/components/DrinkPlanCard.js`: add the "Finalize BEO" button (gated on `status='reviewed'`), the "Unfinalize" button (gated on `finalized_at !== null`), and a small "Finalized [time]" timestamp readout.
- `client/src/components/DrinkPlanCard.test.js` (if it exists, otherwise inline rendering smoke): button visibility per state.
- `client/src/pages/staff/StaffShifts.js`: add the BEO link + state badge described in 6.7.
- `client/src/pages/staff/StaffEvents.js`: same.
- `client/src/pages/admin/EventDetailPage.js`: add the per-staffer "Confirmed [time]" pill to the staff-assignment block; add a "View BEO" link near the DrinkPlanCard.

### Docs (mandatory per CLAUDE.md)
- `README.md`: folder tree (new `beo.js` route, new `beoHandlers.js` util, new `StaffBeo.js` page); Key Features (add BEO surface line).
- `ARCHITECTURE.md`: route table (4 new rows for finalize / unfinalize / GET BEO / acknowledge); schema section (the three new columns); scheduled-message section (`beo_unack_nudge_sms`).
- `CLIENT_FACING_SURFACES.md`: not applicable (staff-facing, not client).

## 11. Testing approach

**Server unit tests** (node:test, real dev DB per existing pattern):

- `beoHandlers.test.js`:
  - `scheduleBeoNudgesForProposal` inserts one row per approved staffer per shift, idempotent under repeat calls
  - `scheduleBeoNudgesForProposal` skips cancelled / un-approved staffers
  - `scheduleBeoNudgesForProposal` with late finalize (event in 1 day) collapses to NOW+5min
  - `deleteBeoNudgesForProposal` DELETEs every row for the proposal's shifts so the next Finalize starts clean
  - `handleBeoUnackNudge` gate suppresses each of: not finalized, already acked, unassigned, archived (one test per gate)
  - `handleBeoUnackNudge` sends + logs SMS via `sendAndLogSms` when all gates pass

- `beo.test.js` (route):
  - Staff with approved shift can GET; staff without cannot (403)
  - Admin can GET regardless
  - Acknowledge endpoint stamps `beo_acknowledged_at` for an approved staff user
  - Acknowledge endpoint is a no-op (200, `acknowledged: false`) for admin
  - Acknowledge endpoint refuses when `finalized_at IS NULL` (409)

- `smsInbound.test.js` additions:
  - Staff CONFIRM with a finalized-unacked BEO stamps `beo_acknowledged_at`, not `acknowledged_at`
  - Staff CONFIRM with no finalized BEO falls through to existing path (stamps `acknowledged_at`)
  - Staff CONFIRM with neither replies "no_shift" as today

- `staffShiftHandlers.test.js` additions:
  - `scheduleStaffShiftMessages` on a freshly approved staff member, on a proposal whose drink plan is finalized, inserts the BEO nudge row
  - `reanchorStaffShiftMessages` updates `scheduled_for` on pending BEO rows when the event is rescheduled

**Client smoke tests** (existing `react-scripts` build under `CI=true` is the gate):

- `CI=true react-scripts build` passes
- Manual: open the BEO page as staff (approved shift), confirm button visible after finalize, acknowledge persists across refresh, badge in StaffShifts swaps from Ready to Confirmed

**Manual verification matrix** (ship gate):

1. Admin: Drink-plan card shows Mark reviewed → Finalize BEO → Unfinalize, in that gated order
2. Admin: Finalize on a proposal with two approved staffers schedules two pending nudge rows at the expected `scheduled_for`
3. Admin: Unfinalize cancels the rows and clears any `beo_acknowledged_at`
4. Staff: Open BEO pre-finalize → banner, no button. Post-finalize → button. Click → pill.
5. Staff: SMS CONFIRM with finalized-unacked BEO → BEO ack stamped, reply mentions BEO
6. Staff: SMS CONFIRM with no finalized BEO → shift ack stamped as today
7. Late finalize: finalize a proposal whose event is in 2 days → nudge fires within minutes
8. Late assignment: approve a fresh `shift_request` on a finalized proposal → nudge row appears
9. Reschedule: change the event date by 7 days → pending nudge `scheduled_for` updates correctly
10. Archive: archive a proposal with a pending nudge → next dispatcher tick suppresses the row

## 12. SMS dispatcher gate: implementation note

The dispatcher's existing handler contract is "handler runs, success → row is sent, throw → row is failed." We need a third outcome: "row should be suppressed for a known reason without alerting." Two options:

- **Option A (preferred):** inside the handler, when a gate fails, UPDATE the row's status to `suppressed` with `error_message` set, then return without calling `sendAndLogSms`. The dispatcher's post-handler step writes a final `sent` status only if no row update happened; we sidestep that by mutating the row inside the handler and reading status before the overwrite. This is the same shape `scheduledMessageDispatcher.js` uses for the marketing gate (`meta?.category === 'marketing'` plus `marketing_enabled === false`).
- **Option B:** introduce a `SuppressMessageError` class that the dispatcher catches and maps to `suppressed`. Cleaner contractually but touches the dispatcher.

The implementation plan picks Option A unless the dispatcher's current code makes A awkward (in which case the plan adds Option B as a minimal extension).

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
