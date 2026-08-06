---
lanes:
  - id: duty-engine
    footprint:
      - server/db/schema.sql
      - server/db/index.js
      - server/utils/dutyLines.js
      - server/utils/dutyLines.test.js
      - server/utils/payrollAccrual.js
      - server/utils/payrollAccrual.duty.test.js
      - server/utils/payrollProcessing.js
      - server/utils/payrollProcessing.test.js
      - server/utils/payrollClawback.js
      - server/utils/payrollLateTip.js
      - server/utils/serviceExtensionPayroll.js
      - server/routes/admin/payrollDuty.js
      - server/routes/admin/payrollDuty.test.js
      - server/routes/admin/payroll.js
      - server/routes/admin/index.js
      - server/utils/paystubData.js
      - server/utils/paystubPdf.js
      - server/utils/paystubPdf.test.js
      - server/routes/staffPortal/payouts.js
      - server/routes/staffPortal/payouts.paystub.test.js
      - server/routes/staffPortal.js
      - server/routes/staffPortal.test.js
      # Reversal hooks: the real COMMIT points turned out to be the cancel
      # EXECUTE route and the shared refund chokepoint, not the utils the plan
      # first named (build-time discovery, reconciled 2026-08-06).
      - server/routes/proposals/cancelLineItem.js
      - server/routes/proposals/menuPrint.js
      - server/utils/refundExecute.js
      # Staff-facing duty rendering: no other lane owns client/src/pages/staff,
      # and shipping the server payload without these un-foots the staff view
      # (consistency-review B1) — widened here, the money-display owner.
      - client/src/pages/staff/PayoutDetail.js
      - client/src/pages/staff/HomePage.js
      - client/src/components/staff/BeoSections.js
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
      - server/routes/staffShiftActions.js
      - server/utils/autoAssign.js
      - server/utils/eventCreation.js
      - server/utils/serviceArea.js
      - server/utils/serviceArea.test.js
      - server/routes/proposals/crud.js
      - server/routes/proposals/remoteStaffing.test.js
      - client/src/pages/admin/EventDetailPage.js
      - client/src/pages/admin/ProposalCreate.js
      - client/src/pages/admin/ProposalDetail.js
    deps: [duty-engine]
    review: full-fleet
  - id: reviews
    footprint:
      - server/routes/admin/staffReviews.js
      - server/routes/admin/staffReviews.test.js
      - server/routes/admin/index.js
      - server/routes/thumbtack.js
      - client/src/pages/admin/StaffReviews.js
      - client/src/App.js
    # admin/index.js overlaps duty-engine's footprint; deps serialize the lanes
    # so the mount edits never collide.
    deps: [duty-engine]
    review: full-fleet
  - id: policy-text
    footprint:
      - client/src/pages/FieldGuide.js
      - server/data/contractorAgreement.js
    # Not pure copy: CURRENT_VERSION stamps into every future signature row and
    # PDF storage key (routes/agreement.js). Light look PLUS consistency-check.
    deps: []
    review: consistency-check
---

# Contractor Duty Pay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-06-contractor-duty-pay-design.md` (read it first; §12 carries verified code anchors). Money seam: read `.claude/seam-sweep-2026-07-02.md` before lane duty-engine. Revised 2026-08-06 after the /review-plan fleet (12 blockers folded in: footprint repairs, task-order swap, correction-path tasks, anchor fixes).

**Goal:** Duty-based contractor pay (bar rental, parking, equipment/hosted supplies, menu print, out-of-area bonus, review bounty/contest) derives automatically into typed payroll lines that are editable, removable, attributed, itemized on paystubs, and safe against every existing payroll recompute path.

**Architecture:** A new `payout_duty_lines` table plus a `duty_attributions` staging table; a pure trigger module derives desired lines inside `accruePayoutsForProposal` and reconciles both directions (insert missing, update changed auto amounts, system-remove trigger-false lines while the period is open, hold admin-owned lines of off-roster workers). `recomputePayoutTotal` becomes the single writer of `payouts.total_cents` (clamp over the WHOLE sum, spec §3.3); all six existing recompute sites route through it. Review money materializes from `staff_reviews` with hard uniqueness keys and a catch-up pass. Out-of-Area is a capped, lockable amount on the shift with server-derived suggestions; the Remote Staffing Fee is an admin send-time surcharge.

**Tech Stack:** Express 4 / raw SQL via `pg`, node:test suites against the shared dev DB, React 18 (CRA), pdfkit paystubs (flow cursor), Nominatim geocoding.

## Global Constraints

- All money in integer cents. Dollars sources (`proposal_addons.line_total`, `pricing_snapshot`, `total_price`, `amount_paid`) cross via `Math.round(Number(x) * 100)` exactly once, at the trigger boundary.
- `payouts.total_cents` is written ONLY by `recomputePayoutTotal` / `recomputePayoutTotals` (bulk). Formula: `GREATEST(0, SUM(payout_events.line_total_cents) + SUM(payable duty amount_cents))` — the clamp wraps the WHOLE sum so clawback debt nets against duty pay. Payable = `removed_at IS NULL AND (held_state IS NULL OR held_state = 'confirmed')`. Any other `UPDATE payouts SET total_cents` is a defect.
- Duty-line inserts always `ON CONFLICT DO NOTHING`. Removed rows are never deleted and never auto-resurrected; system removals (`removed_by IS NULL`) may be system-cleared when the trigger returns true, admin removals never.
- Funded gate everywhere: `Math.round(amount_paid*100) >= Math.round(total_price*100)`, mirroring `payrollAccrual.js:296-298`. Never key on invoice label text.
- Schema statements idempotent (`IF NOT EXISTS`). Explicit `git add <path>` only. No em dashes in any client-facing or field-guide copy.
- Server suites: one at a time, from repo root, `node -r dotenv/config --test server/...test.js`; shared dev DB; copy the `NODE_ENV === 'production'` refusal guard from neighboring suites; fixtures use America/Chicago-keyed dates.
- Client changes verify with `cd client && CI=true npx react-scripts build`.
- Schema applies at server boot (`initDb`); the dev server is a Claude-managed background process with NO auto-reload. After any schema or server edit, RESTART the dev server before a manual walk.
- After any change to a function, grep its callers and run THOSE suites too.
- Kind labels live in ONE server constant (`dutyLines.js` `DUTY_KIND_LABELS`) and reach the client only inside API payloads. The out-of-area suggestion bands likewise live server-side only (`serviceArea.js`); the client renders `suggested_fee_cents` from payloads and never embeds band numbers (spec §6 published-ambiguity rule; the CRA bundle is shared with the public site).

---

## Lane duty-engine

### Task 1: Schema + critical-index registration

**Files:**
- Modify: `server/db/schema.sql` (append; all idempotent), `server/db/index.js` (`CRITICAL_INDEXES`)

**Interfaces:**
- Produces: tables `staff_reviews`, `staff_review_credits`, `payout_duty_lines`, `duty_attributions`; columns on `shifts` and `proposals` below. Order matters: `staff_reviews` is created BEFORE `payout_duty_lines` so the FK is real.

- [ ] **Step 1: Append DDL** (grep each name for collisions first)

```sql
-- Duty pay (spec 2026-08-06-contractor-duty-pay-design.md §3, §7)
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

CREATE TABLE IF NOT EXISTS payout_duty_lines (
  id SERIAL PRIMARY KEY,
  payout_id INTEGER NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
  contractor_id INTEGER NOT NULL REFERENCES users(id),
  shift_id INTEGER REFERENCES shifts(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('bar_rental','parking','equipment_supplies','hosted_supplies','menu_print','out_of_area','review_bounty','review_contest')),
  amount_cents INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'auto' CHECK (origin IN ('auto','admin')),
  admin_owned BOOLEAN NOT NULL DEFAULT FALSE,
  held_state TEXT CHECK (held_state IN ('held','confirmed')),
  removed_at TIMESTAMPTZ,
  removed_by INTEGER REFERENCES users(id),
  note TEXT,
  staff_review_id INTEGER REFERENCES staff_reviews(id),
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

ALTER TABLE shifts ADD COLUMN IF NOT EXISTS out_of_area_bonus_cents INTEGER;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS out_of_area_attached_by INTEGER REFERENCES users(id);
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS out_of_area_attached_at TIMESTAMPTZ;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS out_of_area_locked_at TIMESTAMPTZ;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS out_of_area_locked_user_id INTEGER REFERENCES users(id);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS remote_fee_prompted_at TIMESTAMPTZ;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS venue_lat NUMERIC(9,6);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS venue_lng NUMERIC(9,6);
```

- [ ] **Step 2: Register the three partial UNIQUE indexes in `CRITICAL_INDEXES`** (`server/db/index.js:181`). Its own comment warns a partial UNIQUE failing on duplicate data raises 23505, which `IDEMPOTENT_PG_CODES` swallows; unregistered, a silently-absent duty-money guard would boot clean.
- [ ] **Step 3: Restart the dev server (schema applies at boot via `initDb`); verify tables exist (query `information_schema.tables` via a scratch node script)**
- [ ] **Step 4: Commit** (`git add server/db/schema.sql server/db/index.js`)

### Task 2: `dutyLines.js` — kinds, triggers, reconcile, materializers

**Files:**
- Create: `server/utils/dutyLines.js`
- Test: `server/utils/dutyLines.test.js`

**Interfaces (later tasks and lanes rely on these exact names):**
- `DUTY_KINDS`, `DUTY_KIND_LABELS` (`bar_rental: 'Bar rental'`, `parking: 'Parking'`, `equipment_supplies: 'Equipment & supplies'`, `hosted_supplies: 'Hosted supplies & load'`, `menu_print: 'Menu print'`, `out_of_area: 'Out-of-Area Bonus'`, `review_bounty: 'Review bounty'`, `review_contest: 'Review contest award'`)
- `ATTRIBUTED_KINDS = ['bar_rental','equipment_supplies','hosted_supplies','menu_print']`
- `HOSTED_SUPPLY_HOURS = 2.5` (named constant; policy range 2 to 3)
- `isFundedProposal(proposal) -> boolean`
- `computeDesiredDutyLines({ proposal, pkg, addons, workers, shift, attributions }) -> [{contractor_id, shift_id, kind, amount_cents}]` — pure, no DB
- `reconcileDutyLines(client, { proposalId, desired, payoutIdByContractor, shiftId, periodOpen }) -> {inserted, updated, systemRemoved, restored, held, frozenSkips}` — `frozenSkips` lists lines that SHOULD change but sit in a frozen payout/period; every caller Sentry-captures them (spec §3.2 alert-only rule)
- `sumPayableDutyCents(client, payoutId) -> integer` (payable per Global Constraints)
- `listUnattributedDuties(client, payPeriodId) -> [{proposal_id, kind, eligible_user_ids, stale}]` — includes BOTH missing attributions AND `stale: true` rows whose attributed user is off the approved roster (spec §3.5 re-attribution flag)
- `materializeReviewLine(client, { staffReviewId, contractorId }) -> row|null` — find-or-create the contractor's payout in the current OPEN period; insert $10 `review_bounty` `ON CONFLICT DO NOTHING`; on insert, recompute that payout's total via `payrollProcessing.recomputePayoutTotal` (require inline to avoid cycles); null when no open period (the review waits)
- `materializeContestAward(client, { contractorId, quarter, amountCents }) -> row|null` — same shape, contest index, recompute on insert
- `materializePendingReviewLines(client) -> {materialized}` — the CATCH-UP PASS: scan `staff_reviews` `status='confirmed' AND stars=5` whose credits lack a `review_bounty` line, materialize each. Called from the backfill script (Task 7), after every review confirm (Task 15), and safe to call any time.

Trigger rules inside `computeDesiredDutyLines` (spec §2/§4.2; all gated on `isFundedProposal`):

```js
const hosted = isHostedPackage(pkg); // from pricingEngine
const cents = (x) => Math.round(Number(x || 0) * 100);
const bartenders = workers.filter(w => isBartender(w.position));
const pickupCents = (addons || [])
  .filter(a => a.requires_provisioning && a.slug !== 'parking-fee')
  .reduce((s, a) => s + cents(a.line_total), 0);
// bar_rental: !hosted && num_bars > 0 && cents(snapshot.bar_rental?.total) > 0 -> 2000 to attributed bartender
// parking: addons has parking-fee with line_total > 0 -> 2000 to EVERY worker, no attribution
// equipment_supplies: !hosted && pickupCents >= 5000 -> 2000 to attributed worker (bar money excluded by design)
// hosted_supplies: hosted && (pickupCents > 0 || num_bars > 0)
//   -> Math.round(HOSTED_SUPPLY_HOURS * Number(w.hourly_rate) * 100) at the attributed worker's OWN rate
// menu_print: proposal.menu_print_key && !proposal.menu_not_required -> 500 to attributed bartender
// out_of_area: shift.out_of_area_locked_user_id set && that user is in workers
//   -> shift.out_of_area_bonus_cents to that user
// Attributed kinds emit a line ONLY when an attribution row exists for (proposal, kind)
// and that user is still in workers.
```

`reconcileDutyLines` semantics (single transaction, caller's client):
1. INSERT each desired auto line, `ON CONFLICT DO NOTHING` (concurrent runs never abort the surrounding transaction).
2. UPDATE amount on existing auto, not-admin-owned, not-removed lines whose desired amount changed (a bonus RAISED after materialization must propagate; reduce is impossible by the lock, but the code path is symmetric).
3. System-remove (`removed_at=NOW(), removed_by=NULL, note='trigger no longer met'`) auto, not-admin-owned, not-removed event-kind lines NOT in the desired set — only when `periodOpen`. Off-roster contractors fall out naturally (M5 analog).
4. HOLD instead of remove for `admin_owned` lines whose contractor left the desired set: `held_state='held'` (excluded from totals until an admin edit confirms; mirrors the payout_events chip semantics).
5. Restore system-removed rows back in the desired set (`removed_at IS NOT NULL AND removed_by IS NULL`): clear `removed_at`, note `'trigger restored'`.
6. Anything that should change but is frozen (payout paid / period processing or paid) goes into `frozenSkips` instead of being written.

- [ ] **Step 1: Failing tests** — pure cases: funded false → empty; hosted with pickups → one `hosted_supplies` at `HOSTED_SUPPLY_HOURS` x that worker's rate, NO `bar_rental`/`equipment_supplies`; $50.00 boundary fires, $49.99 does not; parking pays every worker incl. barback; attributed kind without attribution row → nothing; with it → line. DB cases (chicago-keyed fixtures): reconcile idempotent on re-run; amount-update propagates; system-remove on trigger-false; admin removal never resurrected; system removal restored; admin_owned off-roster → held; frozen state → frozenSkips, no write; `ON CONFLICT` swallows a concurrent duplicate; `materializeReviewLine` pays once across a double call and recomputes the total; `materializePendingReviewLines` pays a confirmed review logged while no period was open once a period exists.
- [ ] **Step 2: Run** `node -r dotenv/config --test server/utils/dutyLines.test.js` — FAIL (module missing)
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to green**
- [ ] **Step 5: Commit**

### Task 3: Single-writer totals (formula first, engine hooks second)

**Files:**
- Modify: `server/utils/payrollProcessing.js`, `server/utils/payrollAccrual.js` (:261, :632), `server/utils/payrollClawback.js` (:240-262), `server/utils/payrollLateTip.js` (:199-206), `server/utils/serviceExtensionPayroll.js` (:154-161)
- Test: extend `server/utils/payrollProcessing.test.js` (exists; pins the old semantics at :59, :83)

**Interfaces:**
- `recomputePayoutTotal(executor, payoutId)` — extended: `GREATEST(0, events_sum + payable_duty_sum)` per Global Constraints. Keep the existing return shape.
- NEW `recomputePayoutTotals(executor, payoutIds)` — bulk variant (the four bulk writers are `WHERE po.id = ANY($1)`); same formula, one statement.
- Clawback caution: `payrollClawback.js:240-262` consumes `RETURNING ... AS raw_sum` to drive the clamp-residual Sentry warning. The refactor must keep that alarm working: `raw_sum` now includes payable duty cents, so the residual math stays truthful and does not false-fire.

- [ ] **Step 1: Failing tests**: payout with duty lines → total includes them; payout with ZERO duty lines → total byte-identical to the pre-change value (behavior-unchanged evidence for all refactored sites); clawback-debt case: events sum -5000, duty +2000 → total 0 (clamp wraps the whole sum); residual alarm does not fire on a normal clawback with duty lines present.
- [ ] **Step 2: Extend + add bulk variant + refactor all six sites.** Then `grep -rn "SET total_cents" server/` — any remaining writer outside `payrollProcessing.js` is a defect.
- [ ] **Step 3: Run this suite, then `payrollClawback`, `payrollLateTip`, `serviceExtensionPayroll`, admin payroll suites, one at a time. Green.**
- [ ] **Step 4: Commit**

### Task 4: Accrual integration + payout lifecycle guards

**Files:**
- Modify: `server/utils/payrollAccrual.js`
- Test: `server/utils/payrollAccrual.duty.test.js`

**Interfaces:**
- Consumes: Tasks 2-3. Produces: `accruePayoutsForProposal` derives duty lines on every run, INCLUDING the empty-roster path; both empty-payout deletes spare duty-only payouts.

- [ ] **Step 1: Failing tests**: completing a funded proposal with a bar creates the bartender's $20 `bar_rental` line and the payout total includes it (Task 3 landed, so this asserts totals now); re-run changes nothing; worker drops then re-accrual system-removes their auto lines and holds their admin_owned ones; LAST worker drops (`no_approved_workers` path) → duty lines still reconciled away, not orphaned; a payout holding only a review line survives both empty-payout sweeps.
- [ ] **Step 2: Widen the proposal SELECT** (`payrollAccrual.js:132-136`) to also fetch `num_bars`, `menu_print_key`, `menu_not_required`, and load the package row (for `isHostedPackage`) — the triggers need them.
- [ ] **Step 3: Integrate**: after the worker/payout upsert loop (post :421-430): (a) auto-write `duty_attributions` for kinds with exactly one eligible worker (`INSERT ... ON CONFLICT (proposal_id, kind) DO NOTHING`; eligible sets per spec §5: bartenders for bar/menu, all workers for equipment/hosted; zero eligible → no row, admin resolves), (b) load attributions + snapshot addons (join `service_addons.requires_provisioning` onto the slugs), (c) `computeDesiredDutyLines`, (d) `reconcileDutyLines`, (e) Sentry-capture `frozenSkips`. CRITICAL: the `no_approved_workers` early return (:276) must ALSO run reconcile with `desired=[]` before returning (the last-worker-drop is the M5 case).
- [ ] **Step 4: Guard both deletes** (:254-259, :614-620): extend `NOT EXISTS payout_events` with `AND NOT EXISTS (SELECT 1 FROM payout_duty_lines d WHERE d.payout_id = po.id AND d.removed_at IS NULL)`.
- [ ] **Step 5: Reversal hooks** — the paths that change triggers without touching accrual must now call it (fire-and-forget, post-commit, existing pattern): `lineItemCancel.js` after a parking/pickup/bar cancel on a completed proposal, `menuPrint.js` DELETE, and the refund path that lowers `amount_paid` on a completed proposal (`refundHelpers.js`). All three are in this lane's declared footprint. Post-commit calls must NOT reuse a released pooled client (one-pooled-connection rule; enter accrual after release the way the existing post-commit tails do).
- [ ] **Step 6: Run new suite + existing accrual/money suites singly. Green. Commit.**

### Task 5: Admin duty API + payload + Process gate

**Files:**
- Create: `server/routes/admin/payrollDuty.js`
- Modify: `server/routes/admin/index.js` (add `router.use('/', require('./payrollDuty'))` alongside the existing requires; routes declare FULL paths like `payroll.js` does — there is no `/payroll` sub-mount to inherit)
- Modify: `server/routes/admin/payroll.js` (payload builder + process gate)
- Test: `server/routes/admin/payrollDuty.test.js`

**Interfaces (payroll-ui consumes these verbatim):**
- Payload: `loadPeriodWithPayouts` (`payroll.js:29-72`) gains per-payout `duty_lines[]` (`id, kind, label, amount_cents, shift_id, origin, admin_owned, held_state, removed_at, note`) — labels from `DUTY_KIND_LABELS`; shift-less lines flagged so the UI can group them under "Other".
- `POST /api/admin/payroll/duty-lines` `{payout_id, kind, amount_cents, shift_id?, note?}` → `origin='admin'`, `admin_owned=true`
- `PATCH /api/admin/payroll/duty-lines/:id` `{amount_cents?, note?}` → `admin_owned=true`; editing a held line sets `held_state='confirmed'`
- `POST /api/admin/payroll/duty-lines/:id/remove` / `.../restore` (restore clears `removed_at`, keeps the stored amount)
- `PUT /api/admin/payroll/duty-attributions` `{proposal_id, kind, user_id}` → upsert; re-validates the user against the approved roster inside the transaction; then RUNS `reconcileDutyLines` for that proposal so a FIRST-TIME attribution materializes its line immediately (not only moves an existing one); an existing line moves payouts in the same transaction with both totals recomputed
- `GET /api/admin/payroll/periods/:id/unattributed-duties` → `listUnattributedDuties` output (missing + stale)
- Process gate in `payroll.js` process handler: `listUnattributedDuties` non-empty → `throw new ConflictError('unattributed duties')` (plain message; the UI gets the LIST from the GET above, never from the 409 body — `ConflictError` carries no payload in this error stack and we do not extend it)
- All endpoints: `auth` + admin role, `asyncHandler`, `AppError` subclasses, `|amount_cents| <= 100000`, kind whitelist, frozen when payout paid or period processing/paid (`reopened` allowed, copied from the existing PATCH guard), every mutation writes `logAdminAction` and ends with `recomputePayoutTotal`.

- [ ] **Step 1: Failing tests**: create/edit/remove/restore recompute totals; frozen rejection; cap rejection; PUT on a fresh multi-staff attribution MATERIALIZES the line; PUT move is transactional and rejects an off-roster user; GET lists a stale attribution after the user drops; process 409s while unattributed and passes after the PUT.
- [ ] **Step 2: Implement; mount in `admin/index.js`; run to green (plus the payroll suite). Commit.**

### Task 6: Paystub + staff portal footing

**Files:**
- Modify: `server/utils/paystubData.js`, `server/utils/paystubPdf.js`, `server/routes/staffPortal/payouts.js`, `server/routes/staffPortal.js`
- Test: extend `server/utils/paystubPdf.test.js` and `server/routes/staffPortal/payouts.paystub.test.js` in place

- [ ] **Step 1: Failing tests**: duty category equals the payable duty sum for period AND YTD; grand total still equals `payouts.total_cents`; held duty lines excluded from the category (mirroring the held-positive-adjustment exclusion already in `paystubData.js:87-111`); a NULL-shift bounty appears under `other_duty_lines`; the portal summary foots.
- [ ] **Step 2: `paystubData.js`**: `duty_total_cents` (period + YTD, payable only) and `duty_lines[]` (kind, label, amount_cents, shift_id).
- [ ] **Step 3: `paystubPdf.js`**: a FIFTH category row "Duty pay" (four exist today: Wages / Gratuity / Card tips / Adjustments, then NET PAID); itemize lines under their event or "Other". The PDF uses pdfkit's FLOW cursor (`doc.y` / `doc.moveDown`), not absolute coordinates: guard row groups with `if (doc.y > PAGE_BREAK_THRESHOLD) doc.addPage()` so duty rows cannot run off the page.
- [ ] **Step 4: Staff portal**: separate pinned query (`WHERE po.contractor_id = $1`, `$1 = req.user.id`); include duty in the summary math; shift-less lines under `other`; the current-period tile (`staffPortal.js:126-129`) labels "includes duty pay" when `event_count = 0` and duty money exists.
- [ ] **Step 5: Run the four touched suites singly; commit**

### Task 7: Ship backfill script + docs

**Files:**
- Create: `scripts/backfill-duty-lines.js` — completed proposals with event date in the current open pay period → `accruePayoutsForProposal` each; then `materializePendingReviewLines` (the review catch-up); log per-proposal results; idempotent; refuses on `NODE_ENV=production` without `--yes`
- Modify: `scripts/money-smoke-list.txt` (add the new suites; note: `testdb-smoke.js` runs `initDb` against the prod-parented `ci-smoke` branch first, so the new tables exist there, and ci-smoke carries prod CHECK constraints the dev DB lacks — green local is not proof), `README.md` (folder tree + script), `ARCHITECTURE.md` (route table; schema; reword the `payouts.total_cents` invariant: "clamped sum of its event lines plus payable duty lines, written only by recomputePayoutTotal(s)")

- [ ] **Step 1: Write script; dry-run on dev; verify lines appear (restart dev server first if schema just changed)**
- [ ] **Step 2: Docs edits; commit**

---

## Lane parking-rewire

### Task 8: Attach parking-fee at v2 drink-plan submit

**Files:**
- Modify: `server/routes/drinkPlans/submit.js`
- Test: `server/routes/drinkPlans/submit.parking.test.js`

**Interfaces:**
- Reference: the v1 `addOns` read is `submit.js:75`; the resolve/upsert fold runs :273-290+ (NOT :263-270 — that block is `addBarRental` → `num_bars`).
- Produces: a v2 submit with `selections.logistics.parking === 'paid'` attaches the `parking-fee` add-on through the same fold/invoice-at-submit path; any other value attaches nothing; attach-only (removal is admin cancel-line-item; plans are submit-once so this only ever RAISES `total_price`).

- [ ] **Step 1: Failing test**: v2 submit with parking 'paid' → add-on present, `total_price` rises by rate x totalStaff, payment status re-evaluated; parking 'free' → nothing; re-submit still blocked.
- [ ] **Step 2: Implement inside the existing submit transaction; run this suite + the drink-plan extras/fold suites; commit**

### Task 9: v2 disclosure copy fix

**Files:**
- Modify: `client/src/pages/plan/v2/steps/DayOfV2.js` (:21-22)

Note: spec §4.3's "expose parking-fee in the admin picker" is ALREADY satisfied — the proposal editor's picker (`ProposalEditorForm.js`) does not run `filterAddons` and shows the add-on today; only the public wizard hides it, which is correct. No `proposalRules.js` change (the earlier signature-change idea reached three undeclared files and broke a test for zero benefit).

- [ ] **Step 1: Fix the copy**: the disclosure currently hardcodes `$20 x num_bartenders`; billing is per STAFF MEMBER (barbacks and servers included). Use the staff count the plan payload exposes when available; otherwise the copy states the rate "per staff member" with no hardcoded product. No em dashes.
- [ ] **Step 2: `cd client && CI=true npx react-scripts build` green. Manual check: v2 planner day-of step shows the corrected sentence. Commit.**

---

## Lane payroll-ui

### Task 10: Duty rows on the payroll screen

**Files:**
- Create: `client/src/pages/admin/payroll/DutyLineRow.js`
- Modify: `client/src/pages/admin/payroll/EventLineItem.js`

**Interfaces:** consumes Task 5's payload (`duty_lines[]` with `label`) and endpoints verbatim. Client-side validation mirrors the server (integer dollars-to-cents, cap $1,000, kind whitelist on the add control) with inline error copy, matching spec §3.6 parity.

- [ ] **Step 1: Implement**: rows under each event (label, dollars input mapped to cents, remove checkbox, restore link, note, held chip reading "held: confirm or zero"); a payout-level "Other" group for NULL-shift lines (bounty/contest); "Add duty line" control with kind select from payload labels; debounced serialized saves, error toast + retry, inputs disabled while saving (copy the `EventLineItem.js` patterns).
- [ ] **Step 2: Client build green.**
- [ ] **Step 3: Manual walk (restart dev server first if the engine lane just merged)**: edit an amount → payout total updates; remove → total drops; restore → returns; held chip clears on edit; "Other" group renders a bounty. Commit.

### Task 11: Attribution modal + Process intercept

**Files:**
- Create: `client/src/pages/admin/payroll/AttributionModal.js`
- Modify: `client/src/pages/admin/payroll/PayRunView.js` (:322 Process control)

**Interfaces:** on Process click, first `GET /periods/:id/unattributed-duties`; non-empty (missing OR stale) → modal: one row per (event, duty) with a select of eligible staffers, stale rows labeled "needs re-attribution"; confirm PUTs each attribution (the server materializes/moves lines) then re-fires Process; dismiss leaves Process blocked with a visible reason. The server 409 is a plain-message backstop: on 409, re-fetch the GET and open the modal — never parse the 409 body.

- [ ] **Step 1: Implement modal + intercept; row-level PUT failure shows inline error + retry**
- [ ] **Step 2: Client build green. Manual walk: single-staff event processes without a modal; two-bartender event demands attribution then processes; direct-409 path recovers. Commit.**

---

## Lane out-of-area

### Task 12: `serviceArea.js` + bonus knob + lock lifecycle

**Files:**
- Create: `server/utils/serviceArea.js` + `server/utils/serviceArea.test.js` — `HOME_BASE = { lat, lng }` (Pilsen storage; Dallas confirms exact coords at build time), `suggestOutOfAreaCents(miles) -> 1000|2000|3500|null` (bands `[40,60) [60,90) [90,120)`, null = custom beyond 120 or under 40), `milesFromHomeBase(lat,lng)` via `haversineDistance`. Bands exist ONLY here (server), per the published-ambiguity rule.
- Modify: `server/routes/shifts.js` — `PATCH /api/shifts/:id/out-of-area` (`requireStaffing`; `{amount_cents|null}`; cap `0 < amount_cents <= 25000`; reject reduce/remove while locked with `ConflictError('bonus locked')`; stamp attached_by/at; `logAdminAction`)
- Modify: `server/routes/shifts.approval.js`, `server/routes/staffShiftActions.js` (NOTE: routes/, not utils/ — 929 lines, sensitive path; drop at :224, claim-cover/emergency-drop per its header), `server/utils/autoAssign.js`: on a request becoming approved while a bonus is attached and unlocked → stamp `out_of_area_locked_at`, `out_of_area_locked_user_id` in the same transaction (admin approval, auto-assign, cover claim — there is no separate staffer accept event). Drop handlers: clear both lock fields, keep the amount (re-arms).
- Test: `server/routes/shifts.bonus.test.js`

**Interfaces:** the Task 2 trigger reads `out_of_area_locked_user_id` + `out_of_area_bonus_cents`; a bonus RAISE after materialization propagates via reconcile's amount-update.

- [ ] **Step 1: Failing tests**: band function; set/edit under cap; over-cap 400; approve stamps lock; locked reduce 409; raise allowed and (with a completed fixture) propagates; drop releases lock, keeps amount; re-approval re-locks to the new user; accrual pays the locked user only.
- [ ] **Step 2: Implement; run this suite + approval/autoAssign/staffShiftActions suites singly; commit**

### Task 13: Venue geocode on shift lifecycle (own commit)

**Files:**
- Modify: `server/utils/eventCreation.js`

- [ ] **Step 1: Implement**: on shift create AND the location-change path that nulls coords (:393-394), when `isVenueComplete(proposal)` (street present), geocode via `geocode.js` applying its `delay` helper (the util has NO built-in throttle); fire-and-forget with Sentry capture on failure; street-less venues stay NULL by design (Nominatim returns confidence-free centroids for street-less queries; "never guess").
- [ ] **Step 2: Verify on dev (restart server; create a test shift with a full street address; coords populate). Commit separately — external-API-in-a-write-path is its own revert unit.**

### Task 14: Distances beside approvals + knob UI

**Files:**
- Modify: `server/routes/shifts.js` (requests/roster GET gains `home_distance_miles` per requester via `haversineDistance` over `contractor_profiles.lat/lng` and `shifts.lat/lng`, NULL when either side lacks coords; plus `suggested_bonus_cents` from `serviceArea.js` when venue coords exist — server-derived, never client bands)
- Modify: `client/src/pages/admin/EventDetailPage.js` (626 lines — headroom fine): knob UI (amount input, suggested line from the payload, locked badge) + "home: N mi" chips on request rows (visible to admin and can_staff managers; accepted decision, spec §6)

- [ ] **Step 1: Fold the GET changes into `shifts.bonus.test.js` (NULL-coord → NULL distance case included)**
- [ ] **Step 2: Client build green; manual walk (restart dev server): distances render, suggestion matches the band, locked badge after approval. Commit.**

### Task 15: Remote Staffing Fee send popup

**Files:**
- Modify: `server/routes/proposals/crud.js` (879 lines — watch the soft cap; extract to a sibling if the addition pushes past it):
  - `GET /api/proposals/:id/remote-staffing-check` (admin): if `proposals.venue_lat` is NULL and `isVenueComplete`, geocode ON DEMAND (throttled) and store `venue_lat/lng`; respond `{venue_distance_miles|null (from HOME_BASE), staff_within_40, staff_uncounted, suggested_fee_cents|null, prompted}`. Active staff = `onboarding_status='approved'`; NULL-coord staff go in `staff_uncounted`, never counted as far. No coords → `venue_distance_miles: null`.
  - `POST /api/proposals/:id/remote-fee-prompt-answered` → stamps `remote_fee_prompted_at`.
- Test: `server/routes/proposals/remoteStaffing.test.js`
- Modify: `client/src/pages/admin/ProposalCreate.js` (the INITIAL SendModal, :440 — `ProposalEditorForm.js` has no send modal; its :732 `onSend` is a notify decision) and `client/src/pages/admin/ProposalDetail.js` (958 lines — non-growing edits only or extract; the resend/invite SendModal at :456/:461): before send, if `staff_within_40 < 3` and not `prompted` and distance non-null → popup: "This venue is ~N miles out, K active staffers within 40 (M uncounted, no geocoded address). Add a Remote Staffing Fee? Suggested $X." Buttons: add suggested / custom amount / send without. "Add" writes `{type:'surcharge', label:'Remote Staffing Fee', amount}` through the existing adjustments path; EVERY choice POSTs prompt-answered, then the send proceeds.

- [ ] **Step 1: Failing server tests (counting rules, uncounted, prompted-once, on-demand geocode stores coords); implement; green**
- [ ] **Step 2: Client popup on both send surfaces; build green; manual walk (restart dev server; a far venue with street address prompts once, never re-prompts). Commit.**

---

## Lane reviews

### Task 16: `staff_reviews` routes + TT ingest + bounty materialization

**Files:**
- Create: `server/routes/admin/staffReviews.js`
- Modify: `server/routes/admin/index.js` (mount, full-path routes)
- Modify: `server/routes/thumbtack.js` (:571-620, inside the signature-verified handler behind `router.use(verifyWebhook)`): after the `thumbtack_reviews` upsert succeeds with rowCount 1 (the replay early-return already exists), INSERT a pending `staff_reviews` row, `ON CONFLICT (tt_review_id) DO NOTHING`
- Test: `server/routes/admin/staffReviews.test.js`

**Interfaces:**
- Admin CRUD: list pending-first; create manual google row (response includes a `duplicate_warning` when a TT-sourced row already covers the same date/text, and the UI surfaces it); PATCH tag credits/stars/excerpt; `POST /:id/confirm` → for each credit with stars=5, `materializeReviewLine`, then `materializePendingReviewLines` (catch-up); `POST /:id/dismiss`. Un-tagging a credit whose line's period is open system-removes the line; if the line is paid → no write, Sentry-visible admin alert (spec §7 alert-only). EVERY mutation writes `logAdminAction`.

- [ ] **Step 1: Failing tests**: TT replay creates exactly one staff_reviews row; double-confirm pays once; 4-star confirm pays nothing; confirm with no open period leaves it confirmed-unmaterialized and `materializePendingReviewLines` pays it later; un-tag removes the open-period line; paid-line un-tag alerts and does not write.
- [ ] **Step 2: Implement; mount; run this suite + the thumbtack suite; commit**

### Task 17: Contest award endpoint (own commit), then leaderboard UI

**Files:**
- Modify: `server/routes/admin/staffReviews.js`: `GET /leaderboard?quarter=2026-Q3` — per contractor: events worked (approved + `dropped_at IS NULL`, event date in quarter), named 5-stars (CONFIRMED reviews only), rate, eligible (>=4 events AND >=2 reviews); `POST /contest-award {quarter}` — winner(s) by rate, tie splits 10000 cents evenly, `materializeContestAward` each (which recomputes totals), `logAdminAction`; idempotent via the contest index (second click returns existing awards, creates nothing).
- Create: `client/src/pages/admin/StaffReviews.js` (log list with confirm/tag + duplicate warning; leaderboard "3 of 10 events reviewed"; award button behind a confirm dialog; empty state "No qualifying staff this quarter."; loading/error per admin patterns)
- Modify: `client/src/App.js` (admin route + nav)

- [ ] **Step 1: Failing tests: floor filters; confirmed-only counting; rate ranking; tie split (2 x $50); double-award idempotent. Implement endpoints; green; COMMIT (money write lands alone).**
- [ ] **Step 2: Build the page + route; client build green; manual walk (log a review, confirm, see the bounty line on payroll). Commit.**

---

## Lane policy-text

### Task 18: Field guide + agreement v3

**Files:**
- Modify: `client/src/pages/FieldGuide.js`, `server/data/contractorAgreement.js`

- [ ] **Step 1: Field guide**: new SECTIONS entry "17 Duty Pay & Bonuses" in plain English, concretely: bar rental $20 (own bar or Pilsen pickup); parking $20 only when the client paid for parking, carpool passengers excluded; equipment and supplies $20, one per event, and hosted events get a flat supply-hours block at your hourly rate instead of the $20; menu print $5 with frame required, the print (and any DRB frame) stays with the client, your own frame can go home, tablet display is fine; review bounty $10 for a 5-star review that names you personally on Google or Thumbtack, quarterly $100 contest (at least 4 events worked and 2 named 5-stars to qualify, highest rate of reviews per event wins, tie splits), never offer a guest or client anything for a review, friends and family do not count; travel: ONLY "Shifts outside our normal service area may include an Out-of-Area Bonus, at company discretion, based on staffing needs."; closing: "Duty pay appears automatically on your payout and is confirmed at payroll time." §08: replace "we'll cover costs if it's pre-approved" with a pointer to §17. §10: add the pointer. NO em dashes.
- [ ] **Step 2: Agreement**: `CURRENT_VERSION = 'contractor-agreement-v3'`, keep v2 in `VERSIONS`; clause 3 gains: "Duty-based fees and bonuses are paid according to the published Field Guide schedule, which the Company may update from time to time." Nothing else moves; no re-consent flow. NOTE the seam: this string stamps into `signature_document_version` and the PDF storage key for every future signer (`routes/agreement.js:132,149,209`) — verify a dev signature renders a v3 PDF.
- [ ] **Step 3: Client build green; commit**

---

## Self-review notes (fleet round folded, 2026-08-06)

- All 12 blockers addressed: footprints repaired (server pieces moved into duty-engine Task 5; `admin/index.js` declared in duty-engine + reviews with deps serializing; `staffShiftActions.js` path corrected to routes/; parking-rewire narrowed to two files, no `filterAddons` change; existing test suites declared), Tasks 3/4 swapped (totals before accrual assertions), clamp formula matches spec §3.3 with the clawback `raw_sum` alarm preserved and a bulk variant, `no_approved_workers` reconciles, PUT-attribution materializes, held mechanics + stale-attribution flag specified, review catch-up pass owned by `materializePendingReviewLines`, frozen-period alerts via `frozenSkips`, 409 stays payload-free (UI reads the GET), venue coords produced on demand + `HOME_BASE` origin in `serviceArea.js`, send surfaces corrected to `ProposalCreate.js` + `ProposalDetail.js`.
- Warnings folded: reversal hooks (Task 4 Step 5), materializers recompute totals, amount-update on raised bonuses, widened accrual SELECT, server-side bands, FK on `staff_review_id`, audit logs on review mutations, TT-duplicate warning, paystub flow-cursor + fifth-row correction, submit.js anchors fixed, restart-dev-server steps added, Task 13 split out, Task 17 money write lands alone, Task 10 manual walk added, policy-text review level raised.
- Docs note: README/ARCHITECTURE live ONLY in duty-engine's footprint. Task 7 therefore documents the WHOLE project's additions up front (all planned routes, components, tables from every lane) so no later lane needs to touch the doc files; if a later lane diverges from the documented shape, the divergence is fixed in the docs during that lane's review as a quick-fix on main.
