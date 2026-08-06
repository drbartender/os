---
lanes:
  - id: duty-engine
    footprint:
      - server/db/schema.sql
      - server/utils/dutyLines.js
      - server/utils/dutyLines.test.js
      - server/utils/payrollAccrual.js
      - server/utils/payrollAccrual.duty.test.js
      - server/utils/payrollProcessing.js
      - server/utils/payrollClawback.js
      - server/utils/payrollLateTip.js
      - server/utils/serviceExtensionPayroll.js
      - server/routes/admin/payrollDuty.js
      - server/routes/admin/payrollDuty.test.js
      - server/routes/admin/payroll.js
      - server/utils/paystubData.js
      - server/utils/paystubPdf.js
      - server/routes/staffPortal/payouts.js
      - server/routes/staffPortal.js
      - scripts/backfill-duty-lines.js
      - scripts/money-smoke-list.txt
      - README.md
      - ARCHITECTURE.md
    deps: []
    review: full-fleet
  - id: parking-rewire
    footprint:
      - server/routes/drinkPlans/submit.js
      - server/routes/drinkPlans/submit.parking.test.js
      - client/src/utils/proposalRules.js
      - client/src/pages/plan/v2/steps/DayOfV2.js
    deps: []
    review: full-fleet
  - id: payroll-ui
    footprint:
      - client/src/pages/admin/payroll/EventLineItem.js
      - client/src/pages/admin/payroll/DutyLineRow.js
      - client/src/pages/admin/payroll/AttributionModal.js
      - client/src/pages/admin/payroll/PayRunView.js
    deps: [duty-engine]
    review: full-fleet
  - id: out-of-area
    footprint:
      - server/routes/shifts.js
      - server/routes/shifts.bonus.test.js
      - server/routes/shifts.approval.js
      - server/utils/staffShiftActions.js
      - server/utils/autoAssign.js
      - server/utils/eventCreation.js
      - server/routes/proposals/crud.js
      - server/routes/proposals/remoteStaffing.test.js
      - client/src/pages/admin/EventDetailPage.js
      - client/src/pages/admin/proposalEditor/ProposalEditorForm.js
      - client/src/pages/admin/ProposalDetail.js
    deps: [duty-engine]
    review: full-fleet
  - id: reviews
    footprint:
      - server/routes/admin/staffReviews.js
      - server/routes/admin/staffReviews.test.js
      - server/routes/thumbtack.js
      - server/utils/dutyLines.js
      - client/src/pages/admin/StaffReviews.js
      - client/src/App.js
    deps: [duty-engine]
    review: full-fleet
  - id: policy-text
    footprint:
      - client/src/pages/FieldGuide.js
      - server/data/contractorAgreement.js
    deps: []
    review: light
---

# Contractor Duty Pay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-06-contractor-duty-pay-design.md` (read it first; §12 carries verified code anchors). Money seam: read `.claude/seam-sweep-2026-07-02.md` before lane duty-engine.

**Goal:** Duty-based contractor pay (bar rental, parking, equipment/hosted supplies, menu print, out-of-area bonus, review bounty/contest) derives automatically into typed payroll lines that are editable, removable, attributed, itemized on paystubs, and safe against every existing payroll recompute path.

**Architecture:** A new `payout_duty_lines` table plus a `duty_attributions` staging table; a pure trigger module derives desired lines inside `accruePayoutsForProposal` and reconciles both directions (insert missing with `ON CONFLICT DO NOTHING`, system-remove trigger-false lines while the period is open). `recomputePayoutTotal` becomes the single writer of `payouts.total_cents`, extended with active duty sums; all six existing recompute sites route through it. Review money materializes from `staff_reviews` with hard uniqueness keys. Out-of-Area is a capped, lockable amount on the shift; the Remote Staffing Fee is an admin send-time surcharge.

**Tech Stack:** Express 4 / raw SQL via `pg`, node:test suites against the shared dev DB, React 18 (CRA), pdfkit paystubs, Nominatim geocoding.

## Global Constraints

- All money in integer cents. Dollars sources (`proposal_addons.line_total`, `pricing_snapshot`, `total_price`, `amount_paid`) cross via `Math.round(Number(x) * 100)` exactly once, at the trigger boundary.
- `payouts.total_cents` is written ONLY by `recomputePayoutTotal`. Any other `UPDATE payouts SET total_cents` is a defect.
- Duty-line inserts always `ON CONFLICT DO NOTHING`. Removed rows (`removed_at IS NOT NULL`) are never deleted and never auto-resurrected; system removals (`removed_by IS NULL`) may be system-cleared when the trigger returns true, admin removals never.
- Funded gate everywhere: `Math.round(amount_paid*100) >= Math.round(total_price*100)`, mirroring `payrollAccrual.js:296-298`. Never key on invoice label text.
- Schema statements idempotent (`IF NOT EXISTS`). Explicit `git add <path>` only. No em dashes in any client-facing or field-guide copy.
- Server suites: one at a time, from repo root, `node --test server/...test.js` with dotenv (`node -r dotenv/config --test ...`); they hit the shared dev DB; copy the `NODE_ENV === 'production'` refusal guard from neighboring suites; fixtures use America/Chicago-keyed dates.
- Client changes verify with `cd client && CI=true npx react-scripts build`.
- After any change to a function, grep its callers and run THOSE suites too.
- Kind labels live in ONE server constant (`dutyLines.js` `DUTY_KIND_LABELS`) and are served to the client in API payloads; the client renders `label` from the payload and never hardcodes kind names.

---

## Lane duty-engine

### Task 1: Schema

**Files:**
- Modify: `server/db/schema.sql` (append; all idempotent)

**Interfaces:**
- Produces: tables `payout_duty_lines`, `duty_attributions`, `staff_reviews`, `staff_review_credits`; columns on `shifts` and `proposals` below. Every later task reads these exact names.

- [ ] **Step 1: Append DDL** (adjust only if a listed name collides; check with grep first)

```sql
-- Duty pay (spec 2026-08-06-contractor-duty-pay-design.md §3)
CREATE TABLE IF NOT EXISTS payout_duty_lines (
  id SERIAL PRIMARY KEY,
  payout_id INTEGER NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES users(id),
  shift_id INTEGER REFERENCES shifts(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('bar_rental','parking','equipment_supplies','hosted_supplies','menu_print','out_of_area','review_bounty','review_contest')),
  amount_cents INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'auto' CHECK (origin IN ('auto','admin')),
  admin_owned BOOLEAN NOT NULL DEFAULT FALSE,
  removed_at TIMESTAMPTZ,
  removed_by INTEGER REFERENCES users(id),
  note TEXT,
  staff_review_id INTEGER,
  contest_quarter TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_duty_lines_event_kinds
  ON payout_duty_lines(payout_id, shift_id, kind)
  WHERE kind NOT IN ('review_bounty','review_contest');
CREATE UNIQUE INDEX IF NOT EXISTS idx_duty_lines_bounty
  ON payout_duty_lines(staff_review_id, contractor_id)
  WHERE kind = 'review_bounty';
CREATE UNIQUE INDEX IF NOT EXISTS idx_duty_lines_contest
  ON payout_duty_lines(contest_quarter, contractor_id)
  WHERE kind = 'review_contest';
CREATE INDEX IF NOT EXISTS idx_duty_lines_payout ON payout_duty_lines(payout_id);

CREATE TABLE IF NOT EXISTS duty_attributions (
  id SERIAL PRIMARY KEY,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('bar_rental','equipment_supplies','hosted_supplies','menu_print')),
  user_id INTEGER NOT NULL REFERENCES users(id),
  attributed_by INTEGER REFERENCES users(id),
  attributed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(proposal_id, kind)
);

CREATE TABLE IF NOT EXISTS staff_reviews (
  id SERIAL PRIMARY KEY,
  review_date DATE NOT NULL,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  source TEXT NOT NULL CHECK (source IN ('google','thumbtack')),
  tt_review_id VARCHAR(100) UNIQUE,
  excerpt TEXT,
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','dismissed')),
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS staff_review_credits (
  id SERIAL PRIMARY KEY,
  staff_review_id INTEGER NOT NULL REFERENCES staff_reviews(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  UNIQUE(staff_review_id, user_id)
);

ALTER TABLE shifts ADD COLUMN IF NOT EXISTS out_of_area_bonus_cents INTEGER;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS out_of_area_attached_by INTEGER REFERENCES users(id);
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS out_of_area_attached_at TIMESTAMPTZ;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS out_of_area_locked_at TIMESTAMPTZ;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS out_of_area_locked_user_id INTEGER REFERENCES users(id);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS remote_fee_prompted_at TIMESTAMPTZ;
```

- [ ] **Step 2: Apply to dev DB** (run schema apply the way the repo does it; verify with `\d payout_duty_lines` via a quick node script or psql)
- [ ] **Step 3: Commit** (`git add server/db/schema.sql`)

### Task 2: `dutyLines.js` — kinds, triggers, reconcile, single-writer sum

**Files:**
- Create: `server/utils/dutyLines.js`
- Test: `server/utils/dutyLines.test.js`

**Interfaces (later tasks and lanes rely on these exact names):**
- `DUTY_KINDS`, `DUTY_KIND_LABELS` (e.g. `bar_rental: 'Bar rental'`, `hosted_supplies: 'Hosted supplies & load'`, `out_of_area: 'Out-of-Area Bonus'`, `review_bounty: 'Review bounty'`, `review_contest: 'Review contest award'`)
- `ATTRIBUTED_KINDS = ['bar_rental','equipment_supplies','hosted_supplies','menu_print']`
- `isFundedProposal(proposal) -> boolean` (cents compare per Global Constraints)
- `computeDesiredDutyLines({ proposal, pkg, addons, workers, shift, attributions }) -> [{contractor_id, shift_id, kind, amount_cents}]` — pure, no DB. `workers` = the accrual roster rows (`user_id`, `position`, `hourly_rate`); `addons` = `pricing_snapshot.addons` array; `attributions` = rows from `duty_attributions`.
- `reconcileDutyLines(client, { proposalId, desired, payoutIdByContractor, shiftId, periodOpen }) -> {inserted, systemRemoved, restored}` — the derive-both-directions writer.
- `sumActiveDutyCents(client, payoutId) -> integer`
- `listUnattributedDuties(client, payPeriodId) -> [{proposal_id, kind, eligible_user_ids}]` (used by the Process gate and the modal)
- `materializeReviewLine(client, { staffReviewId, contractorId }) -> row|null` (finds or creates the contractor's payout in the current OPEN period; inserts $10 `review_bounty` with `ON CONFLICT DO NOTHING`; returns null when no open period, leaving the review waiting)
- `materializeContestAward(client, { contractorId, quarter, amountCents }) -> row|null` (same find-or-create; `ON CONFLICT DO NOTHING` on the contest index)

Trigger rules inside `computeDesiredDutyLines` (spec §2/§4.2; all gated on `isFundedProposal`):

```js
const hosted = isHostedPackage(pkg); // from pricingEngine
const cents = (x) => Math.round(Number(x || 0) * 100);
const bartenders = workers.filter(w => isBartender(w.position));
const pickupCents = (addons || [])
  .filter(a => a.requires_provisioning && a.slug !== 'parking-fee')
  .reduce((s, a) => s + cents(a.line_total), 0);
// bar_rental: !hosted && num_bars > 0 && cents(snapshot.bar_rental?.total) > 0 -> $20 to attributed bartender
// parking: addons has parking-fee with line_total > 0 -> $20 to EVERY worker, no attribution
// equipment_supplies: !hosted && pickupCents >= 5000 -> $20 to attributed worker (bar money excluded by design)
// hosted_supplies: hosted && (pickupCents > 0 || num_bars > 0)
//   -> Math.round(2.5 * Number(w.hourly_rate) * 100) to the attributed worker (their OWN rate)
// menu_print: proposal.menu_print_key && !proposal.menu_not_required -> $5 to attributed bartender
// out_of_area: shift.out_of_area_locked_user_id set && that user is in workers
//   -> shift.out_of_area_bonus_cents to that user
// Attributed kinds emit a line ONLY when an attribution row exists for (proposal, kind)
// and that user is still in workers. Auto-attribution: when exactly one eligible worker
// exists (bartenders for bar_rental/menu_print, all workers for equipment/hosted),
// the CALLER (accrual integration, Task 3) writes the attribution row first.
```

`reconcileDutyLines` semantics (write them as three statements, all inside the caller's transaction):
1. INSERT each desired line (`origin='auto'`) with `ON CONFLICT DO NOTHING` against `idx_duty_lines_event_kinds`.
2. System-remove: `UPDATE payout_duty_lines SET removed_at=NOW(), removed_by=NULL, note='trigger no longer met', updated_at=NOW()` for auto, not-admin-owned, not-removed event-kind lines of this proposal's payouts that are NOT in the desired set — only when `periodOpen`. Off-roster contractors fall out naturally because desired only contains current workers (this is the seam-sweep M5 analog).
3. Restore system-removed rows that ARE back in the desired set (`removed_at IS NOT NULL AND removed_by IS NULL`): clear `removed_at`, note `'trigger restored'`.

- [ ] **Step 1: Write failing tests** — pure-function cases first (no DB): funded gate false → empty; hosted event with pickups → one `hosted_supplies` at 2.5h x that worker's rate and NO `bar_rental`/`equipment_supplies`; BYOB with $50.00 flagged add-ons → `equipment_supplies` exactly at the boundary; $49.99 → none; parking → one line per worker including barbacks; menu print without attribution row → no line; with it → $5 line. Then DB cases with a real client (chicago-keyed fixture proposal/payout): reconcile inserts once, is idempotent on re-run, system-removes on trigger-false, never resurrects an admin removal, restores a system removal, `ON CONFLICT` swallows a concurrent duplicate.
- [ ] **Step 2: Run** `node -r dotenv/config --test server/utils/dutyLines.test.js` — expect FAIL (module missing)
- [ ] **Step 3: Implement** per the interfaces above
- [ ] **Step 4: Run to green**
- [ ] **Step 5: Commit**

### Task 3: Accrual integration + payout lifecycle guards

**Files:**
- Modify: `server/utils/payrollAccrual.js`
- Test: `server/utils/payrollAccrual.duty.test.js`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: `accruePayoutsForProposal` now derives duty lines; both empty-payout deletes spare duty-only payouts.

- [ ] **Step 1: Failing tests**: completing a funded proposal with a bar creates the bartender's $20 `bar_rental` line and the payout total includes it; re-running accrual changes nothing; dropping the worker (dropped_at set) then re-accruing system-removes their duty lines; a payout holding only a review line survives the empty-payout sweep.
- [ ] **Step 2: Integrate**: after the existing worker/payout upsert loop (post `:421-430` seeding), (a) auto-write `duty_attributions` rows for kinds with exactly one eligible worker (INSERT ... ON CONFLICT (proposal_id, kind) DO NOTHING), (b) load attributions + snapshot addons (join `service_addons.requires_provisioning` onto the snapshot slugs), (c) call `computeDesiredDutyLines`, (d) call `reconcileDutyLines` with `periodOpen` from the existing gate. Same transaction, same client (one-pooled-connection rule).
- [ ] **Step 3: Guard both deletes** (`:254-259`, `:614-620`): extend the `NOT EXISTS payout_events` predicate with `AND NOT EXISTS (SELECT 1 FROM payout_duty_lines d WHERE d.payout_id = po.id AND d.removed_at IS NULL)`.
- [ ] **Step 4: Run new suite + the existing accrual/money suites** (grep callers; run each singly). Green.
- [ ] **Step 5: Commit**

### Task 4: Single-writer totals

**Files:**
- Modify: `server/utils/payrollProcessing.js`, `server/utils/payrollAccrual.js` (:261, :632), `server/utils/payrollClawback.js` (:241), `server/utils/payrollLateTip.js` (:200), `server/utils/serviceExtensionPayroll.js` (:155)

**Interfaces:**
- Produces: `recomputePayoutTotal(client, payoutId)` = `GREATEST(0, SUM(payout_events.line_total_cents)) + SUM(active duty amount_cents)`, clamped at 0 overall — match the CURRENT clamp semantics you find in `recomputePayoutTotal` and keep held-line sign scoping exactly as-is; the only change is adding the active-duty term via `sumActiveDutyCents`. Every other site becomes a call to this function.

- [ ] **Step 1: Failing test** (in `payrollAccrual.duty.test.js`): admin-style edit path — after duty lines exist, call the exported `recomputePayoutTotal` and each refactored site's flow; total always includes duty money. Regression: a clawback stub payout still floors at 0.
- [ ] **Step 2: Extend + refactor all six sites.** Grep first: `grep -rn "total_cents" server/utils server/routes/admin/payroll.js` — any remaining direct writer outside `payrollProcessing.js` is a defect.
- [ ] **Step 3: Run**: this suite, then `payrollClawback`, `payrollLateTip`, `serviceExtensionPayroll`, and admin payroll suites, one at a time. Green.
- [ ] **Step 4: Commit**

### Task 5: Admin duty API (`payrollDuty.js`) + Process gate helper

**Files:**
- Create: `server/routes/admin/payrollDuty.js` (mounted under the existing admin payroll prefix; sibling file per the size ratchet)
- Modify: `server/routes/admin/payroll.js` (process endpoint gate only)
- Test: `server/routes/admin/payrollDuty.test.js`

**Interfaces (client lane consumes these):**
- `POST   /api/admin/payroll/duty-lines` `{payout_id, kind, amount_cents, shift_id?, note?}` → manual line, `origin='admin'`, `admin_owned=true`
- `PATCH  /api/admin/payroll/duty-lines/:id` `{amount_cents?, note?}` → sets `admin_owned=true`
- `POST   /api/admin/payroll/duty-lines/:id/remove` / `POST .../restore`
- `PUT    /api/admin/payroll/duty-attributions` `{proposal_id, kind, user_id}` → upsert; re-validates user against the approved roster inside the transaction; moves any existing materialized line to the new contractor's payout (both totals via `recomputePayoutTotal`, one transaction)
- All: `auth` + admin role, `asyncHandler`, `AppError` subclasses, `|amount_cents| <= 100000`, kind from `DUTY_KINDS`, frozen when payout paid or period processing/paid (copy the exact guard from the existing PATCH; `reopened` allowed), every mutation writes a `logAdminAction` row, every mutation ends by calling `recomputePayoutTotal`.
- Process gate: in `payroll.js` process handler, before status flip: `listUnattributedDuties(client, periodId)` non-empty → throw `ConflictError('unattributed duties')` with the list in the payload (409).

- [ ] **Step 1: Failing tests**: create/edit/remove/restore happy paths recompute the total; frozen-period rejection; cap rejection; attribution move is transactional and rejects an off-roster user; process 409s while a multi-staff proposal's `bar_rental` is unattributed and succeeds after the PUT.
- [ ] **Step 2: Implement; mount; run to green** (plus the payroll suite)
- [ ] **Step 3: Commit**

### Task 6: Paystub + staff portal footing

**Files:**
- Modify: `server/utils/paystubData.js`, `server/utils/paystubPdf.js`, `server/routes/staffPortal/payouts.js`, `server/routes/staffPortal.js`

- [ ] **Step 1: Failing tests** (extend the existing paystub/staff-portal suites in place): duty category equals sum of active duty lines for period AND YTD; grand total still equals `payouts.total_cents`; a NULL-shift bounty renders in the payload under `other_duty_lines`; the events summary still foots.
- [ ] **Step 2: `paystubData.js`**: add `duty_total_cents` (period + YTD aggregates, active lines only, held sign-scoping mirrored from the adjustment aggregates) and `duty_lines[]` (kind, label, amount_cents, shift_id).
- [ ] **Step 3: `paystubPdf.js`**: sixth category row "Duty pay"; itemize lines under their event (label + amount) or under "Other"; add a y-cursor page-break guard before each row group (`if (y > PAGE_BREAK_Y) { doc.addPage(); y = TOP_Y; }`) so duty rows cannot overflow the absolute layout.
- [ ] **Step 4: Staff portal**: separate pinned query (`WHERE po.contractor_id = $1` with `$1 = req.user.id`) for duty lines; include in the summary math; shift-less lines under an `other` group; the current-period tile shows "includes duty pay" when `event_count = 0` and duty money exists.
- [ ] **Step 5: Run the touched suites singly; commit**

### Task 7: Ship backfill script + docs

**Files:**
- Create: `scripts/backfill-duty-lines.js` (find completed proposals whose event date falls in the current open pay period; run `accruePayoutsForProposal` over each; log per-proposal results; idempotent by construction; refuses on `NODE_ENV=production` unless `--yes`)
- Modify: `scripts/money-smoke-list.txt` (add the new suites), `README.md` (folder tree: `payrollDuty.js`, `dutyLines.js`, script), `ARCHITECTURE.md` (route table additions; schema section: new tables/columns; reword the `payouts.total_cents` invariant: "clamped sum of its event lines plus active duty lines, written only by recomputePayoutTotal")

- [ ] **Step 1: Write script; dry-run against dev DB; verify lines appear**
- [ ] **Step 2: Docs edits; commit**

---

## Lane parking-rewire

### Task 8: Attach parking-fee at v2 drink-plan submit

**Files:**
- Modify: `server/routes/drinkPlans/submit.js`
- Test: `server/routes/drinkPlans/submit.parking.test.js`

**Interfaces:**
- Consumes: the v1 attach behavior as reference (`submit.js` handled v1 `addOns` around :263-270; the extras fold + invoice-at-submit path already exists).
- Produces: a v2 submit with `selections.logistics.parking === 'paid'` attaches the `parking-fee` add-on (per_staff, engine-priced) through the same fold; any other parking value attaches nothing. Attach only; no detach path (removal is admin cancel-line-item).

- [ ] **Step 1: Failing test**: v2 submit with parking 'paid' → proposal gains the add-on, `total_price` rises by rate x totalStaff, payment status re-evaluated (increase path); parking 'free' → no add-on; re-submit blocked as today (submit-once).
- [ ] **Step 2: Implement inside the existing submit transaction; run to green (plus the drink-plan extras/fold money suites); commit**

### Task 9: Admin picker exposure + v2 copy fix

**Files:**
- Modify: `client/src/utils/proposalRules.js` (:116 — scope the parking-fee hide to the public wizard context only; the admin editor context shows it. `filterAddons` gains an explicit `{ context }` argument if it lacks one; grep every caller and pass their context)
- Modify: `client/src/pages/plan/v2/steps/DayOfV2.js` (:21-22 — the disclosure must state per-staff-member math over ALL staff, not `num_bartenders`; use the staff count the plan payload exposes, else the copy reads "per staff member" with the rate and no hardcoded product)

- [ ] **Step 1: Make both edits; grep `filterAddons(` callers and update each**
- [ ] **Step 2: `cd client && CI=true npx react-scripts build` green; commit**

---

## Lane payroll-ui

### Task 10: Duty rows on the payroll screen

**Files:**
- Create: `client/src/pages/admin/payroll/DutyLineRow.js` (one line: label from payload, amount input in dollars mapped to cents on save, remove checkbox, restore link, note; debounced serialized saves copied from `EventLineItem.js` patterns; error toast + retry; inputs disabled while saving)
- Modify: `client/src/pages/admin/payroll/EventLineItem.js` (render `duty_lines` under the event; "Add duty line" admin control invoking `POST /duty-lines` with a kind select from the payload's labels)

**Interfaces:** consumes Task 5's endpoints verbatim; the payroll payload must include each payout's duty lines with `label` (extend the existing admin payroll GET in `payrollDuty.js` or the existing list query — whichever the payload builder is; grep where `payout_events` are serialized for the screen and add the sibling query there, pinned by payout ids).

- [ ] **Step 1: Implement; empty state = section simply absent; loading/disabled per existing patterns**
- [ ] **Step 2: Client build green; commit**

### Task 11: Attribution modal + Process intercept

**Files:**
- Create: `client/src/pages/admin/payroll/AttributionModal.js`
- Modify: `client/src/pages/admin/payroll/PayRunView.js` (:322 Process control)

**Interfaces:** on Process click, first `GET` the unattributed list (expose `GET /api/admin/payroll/periods/:id/unattributed-duties` in `payrollDuty.js` wrapping `listUnattributedDuties` — add it in this lane, same file, same guards); if non-empty, open the modal: one row per (event, duty) with a select of eligible staffers (names from the payload); confirm PUTs each attribution then re-fires Process; dismiss leaves Process blocked with a visible reason line; the server 409 remains the backstop and its payload renders the same modal.

- [ ] **Step 1: Implement modal + intercept; handle PUT failure inline (row-level error, retry)**
- [ ] **Step 2: Client build green; manual walk on dev (single-staff event skips modal; two-bartender event demands it; 409 path renders)**
- [ ] **Step 3: Commit**

---

## Lane out-of-area

### Task 12: Bonus knob + lock lifecycle

**Files:**
- Modify: `server/routes/shifts.js` (new `PATCH /api/shifts/:id/out-of-area` — `requireStaffing`; body `{amount_cents|null}`; cap `0 < amount_cents <= 25000`; reject any reduce/remove while `out_of_area_locked_at` is set with `ConflictError('bonus locked')`; stamp attached_by/at; `logAdminAction`)
- Modify: `server/routes/shifts.approval.js`, `server/utils/staffShiftActions.js` (claim-cover), `server/utils/autoAssign.js`: at the moment a request becomes approved while `out_of_area_bonus_cents` is set and unlocked, stamp `out_of_area_locked_at=NOW(), out_of_area_locked_user_id=<user>` in the same transaction. In the drop handlers (`staffShiftActions.js` drop/emergency-drop): clear both lock fields, keep the amount (re-arms for the next assignee).
- Test: `server/routes/shifts.bonus.test.js`

**Interfaces:** the accrual trigger from Task 2 reads `out_of_area_locked_user_id` + `out_of_area_bonus_cents`; nothing else pays.

- [ ] **Step 1: Failing tests**: set/edit under cap; over-cap 400; approve stamps lock; locked reduce 409; drop releases lock and keeps amount; second approval re-locks to the new user; accrual pays the locked user only.
- [ ] **Step 2: Implement; run this suite + approval/autoAssign suites singly; commit**

### Task 13: Distances beside approvals + venue geocode

**Files:**
- Modify: `server/routes/shifts.js` (the requests/roster GET gains `home_distance_miles` per requester: `haversineDistance` over `contractor_profiles.lat/lng` and `shifts.lat/lng`; NULL when either side lacks coords; visible to `requireStaffing` — manager visibility is an accepted decision, spec §6)
- Modify: `server/utils/eventCreation.js`: on shift create AND on the location-change path that today nulls coords (:393-394), when `isVenueComplete(proposal)` (street present), geocode via `geocode.js` (apply its delay helper; fire-and-forget with Sentry capture on failure); street-less venues stay NULL by design.
- Modify: `client/src/pages/admin/EventDetailPage.js`: knob UI (amount input, suggested amount line, locked badge) + "home: N mi" chips on the request rows; suggestion = bands `[40,60)=$10, [60,90)=$20, [90,120)=$35, 120+='custom'` computed client-side from the venue distance the payload provides.

- [ ] **Step 1: Implement server bits with tests folded into `shifts.bonus.test.js` (distance NULL-coord case included)**
- [ ] **Step 2: Client build green; manual walk; commit**

### Task 14: Remote Staffing Fee send popup

**Files:**
- Modify: `server/routes/proposals/crud.js`: `GET /api/proposals/:id/remote-staffing-check` (admin) → `{venue_distance_miles|null, staff_within_40, staff_uncounted, suggested_fee_cents|null, prompted: !!remote_fee_prompted_at}` — active staff = `onboarding_status='approved'`; NULL-coord staff counted in `staff_uncounted`, never in `staff_within_40`; venue coords absent → `venue_distance_miles: null` and the client shows no popup. Plus `POST /api/proposals/:id/remote-fee-prompt-answered` stamping `remote_fee_prompted_at`.
- Test: `server/routes/proposals/remoteStaffing.test.js`
- Modify: `client/src/pages/admin/proposalEditor/ProposalEditorForm.js` (SendModal path) and `client/src/pages/admin/ProposalDetail.js` (the bare send/status action): before sending, if check says `staff_within_40 < 3` and not `prompted` and distance non-null, popup with add-suggested / custom / send-without; "add" writes a `{type:'surcharge', label:'Remote Staffing Fee', amount}` adjustment through the existing adjustments edit path; every choice POSTs prompt-answered, then proceeds with the send.

- [ ] **Step 1: Failing server tests (counting rules incl. uncounted + prompted-once); implement; green**
- [ ] **Step 2: Client popup on both send surfaces; build green; manual walk; commit**

---

## Lane reviews

### Task 15: `staff_reviews` routes + TT ingest + bounty materialization

**Files:**
- Create: `server/routes/admin/staffReviews.js` (admin CRUD: list with pending-first, create manual google row, PATCH tag credits/stars/excerpt, `POST /:id/confirm` → for each credit with stars=5 call `materializeReviewLine`; `POST /:id/dismiss`; un-tagging a credit while its line's period is open system-removes that line; confirm on a review whose line was already paid → no new write, warning in response)
- Modify: `server/routes/thumbtack.js` (:571-620): inside the existing signature-verified review handler, after the `thumbtack_reviews` upsert succeeds (rowCount 1 only — the replay early-return already exists), INSERT a pending `staff_reviews` row with `tt_review_id`, `ON CONFLICT (tt_review_id) DO NOTHING`
- Modify: `server/utils/dutyLines.js` — nothing new; `materializeReviewLine`/`materializeContestAward` were built in Task 2
- Test: `server/routes/admin/staffReviews.test.js`

- [ ] **Step 1: Failing tests**: TT replay creates exactly one staff_reviews row; confirm pays each credited staffer once (`UNIQUE(staff_review_id, contractor_id)` proves it on a double-confirm); 4-star confirm pays nothing; no-open-period confirm leaves the row confirmed-but-unmaterialized and a later materialize pass pays it; un-tag removes the open-period line.
- [ ] **Step 2: Implement; run this suite + the thumbtack suite; commit**

### Task 16: Leaderboard + contest award + admin UI

**Files:**
- Modify: `server/routes/admin/staffReviews.js`: `GET /leaderboard?quarter=2026-Q3` → per contractor: events worked (approved + `dropped_at IS NULL`, event date in quarter), named 5-stars, rate, eligible flag (floor: >=4 events AND >=2 reviews); `POST /contest-award {quarter}` → winner(s) by rate, tie splits `10000` cents evenly, `materializeContestAward` each, `logAdminAction`; idempotent via the contest unique index (second click returns the existing awards, creates nothing).
- Create: `client/src/pages/admin/StaffReviews.js` (log list with confirm/tag; leaderboard table "3 of 10 events reviewed"; award button with confirm dialog; empty state "no qualifying staff this quarter"; loading/error states per admin page patterns)
- Modify: `client/src/App.js` (admin route + nav entry)

- [ ] **Step 1: Failing tests: floor filters; rate ranking; tie split (2 winners x $50); double-award idempotent**
- [ ] **Step 2: Implement; suites green; client build green; commit**

---

## Lane policy-text

### Task 17: Field guide + agreement v3

**Files:**
- Modify: `client/src/pages/FieldGuide.js`: new SECTIONS entry "17 Duty Pay & Bonuses" with the spec §8 schedule in plain English (exact amounts; travel = ONLY "Shifts outside our normal service area may include an Out-of-Area Bonus, at company discretion, based on staffing needs."; review rules incl. "never offer a guest or client anything in exchange for a review; reviews from friends or family do not count"; closing line "Duty pay appears automatically on your payout and is confirmed at payroll time."). §08: replace the "we'll cover costs if it's pre-approved" sentence with a pointer to §17. §10: add the pointer. NO em dashes anywhere in this copy.
- Modify: `server/data/contractorAgreement.js`: `CURRENT_VERSION = 'contractor-agreement-v3'`, keep v2 in `VERSIONS`; clause 3 (Compensation) gains: "Duty-based fees and bonuses are paid according to the published Field Guide schedule, which the Company may update from time to time." No other clause changes; acknowledgments unchanged; no re-consent flow.

- [ ] **Step 1: Make both edits; verify the agreement PDF renders v3 on dev (`agreementPdf.js` iterates clauses; no code change expected)**
- [ ] **Step 2: Client build green; commit**

---

## Self-review notes (done at write time)

- Spec coverage walked §1 through §12: every spec requirement maps to a task (engine 1-7, detection 2/8-9, attribution 5/11, out-of-area 12-14, reviews 15-16, policy 17, backfill + docs 7).
- The six total-writer sites, both empty-payout deletes, and the eight accrual call sites are covered by Tasks 3-4 with grep steps so drifted line numbers cannot silently skip one.
- Names cross-checked: `dutyLines.js` exports referenced by Tasks 3, 5, 11, 15, 16 use identical spellings; endpoint paths in Tasks 5, 10, 11 match.
- Deliberately NOT in any lane: announcement email (Dallas manual), hardware, review funnel page, re-consent (spec §11).
