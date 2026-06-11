# Late-Tip / Clawback Recovery — Frozen-Period Strand Fix

- **Date:** 2026-06-11
- **Branch / worktree:** `late-tip-recovery`
- **Status:** Approved design (revised after spec review), ready for implementation plan
- **Surface:** Payroll tip placement (server) + a small admin payroll panel (client)

## 1. Background

When a late card tip (or a refund clawback) is applied and the open pay period
containing **today** is frozen (`status != 'open'` — mid-`processing` or `paid`), the
placement functions roll back, emit a Sentry **warning**, and return null. The tip is
**stranded silently**: no payout line, no DB marker distinguishable from "not processed
yet," and **no retry trigger**. The only signal is a Sentry warning.

- `server/utils/payrollLateTip.js:85-96` — `rollForwardLateTip` defers (ROLLBACK + Sentry).
- `server/utils/payrollClawback.js:98-108` — `clawbackTip` has the **identical** defer path
  (opposite money direction).

Money impact: a customer paid a tip that never reaches the bartender (under-pay); or a
refunded tip's negative adjustment never lands (DRB keeps owing). Exposure scales with tip
volume; the trigger is uncommon (requires processing next week's period before a delayed tip
for the prior week's event arrives) but real.

Three facts that shape the design (verified in code):
- **The deferred state is not derivable.** A normal tip paid via `accruePayoutsForProposal`
  also has `rolled_forward_at IS NULL` — that column is set **only** by `rollForwardLateTip`.
  So "deferred" needs its own explicit marker.
- **A deferred clawback loses its target.** `clawbackTip(tipId, newCumulativeRefundedCents)`
  takes the target cumulative as an argument and, on defer, rolls back **without advancing**
  `refunded_amount_cents` and **without storing** the target. The Stripe webhook
  (`clawbackTipByPaymentIntent`) treats the null return as success (HTTP 200 — confirmed at
  `server/routes/stripe.js:1555,1560`), so Stripe does **not** re-deliver. The target amount is
  lost — a retry can't know how much to claw. The marker must persist the target.
- **The marker write is itself racy and fallible** (review finding). It happens on a fresh
  connection after the defer ROLLBACK, so a concurrent retry that commits the placement in
  between could resurrect a paid strand, and the write can fail outright. Both are guarded below.

### Decisions locked during design
- **Resolution trigger = Option A:** auto-retry piggybacks on accrual **+** a manual admin
  "Retry" button. **No new scheduler.** The admin "Deferred tips" list closes the only hole in
  A by making any strand visible and one-click-resolvable.
- **Fix the clawback twin in the same pass** — one marker + one sweep, both directions.
- **No automated backfill of pre-ship strands** — see §3.7.

## 2. Scope

- `server/db/schema.sql` — idempotent columns on `tips` (deferral marker) + a partial index.
- `server/utils/payrollLateTip.js` — guarded marker on defer; clear on success; unplaced check.
- `server/utils/payrollClawback.js` — guarded marker (+ target) on defer; clear on success;
  no-line clawback when the tip was never placed.
- `server/utils/payrollDeferredRetry.js` — **new** `retryDeferredTips()` sweep.
- `server/utils/payrollAccrual.js` — fire the sweep after a successful accrual (off the
  response path).
- `server/routes/admin/payroll.js` — `GET /payroll/deferred-tips` + retry endpoint.
- `client/src/pages/admin/payroll/` — a "Deferred tips" panel with a Retry button.
- Tests — `server/utils/payrollDeferredRetry.test.js` (+ defer/clear/race coverage).

### Non-goals
- No dedicated retry scheduler/cron (Option B rejected).
- No change to how tips normally accrue, match shifts, or compute shares/fees/floors.
- No auto-resolution of the `all_bartenders_are_legacy_cc_stubs` case.
- No manual-placement / flat-adjustment admin fallback, and no per-tip Retry button, in v1.
- No automated backfill of pre-ship strands (§3.7).

## 3. Requirements

### 3.1 The deferral marker (schema)
Add to `tips` at the ALTER block (`server/db/schema.sql` ~`:2693`, idempotent
`ADD COLUMN IF NOT EXISTS`):
- `deferred_at TIMESTAMPTZ` — set when placement defers, cleared (NULL) on success. NULL = "not
  deferred." Drives the sweep query, the admin list, and item age.
- `defer_kind TEXT` — `'roll_forward'` | `'clawback'`. Tells the sweep which function to call.
  **Mutually exclusive** (§3.6): a tip is deferred as one or the other, never both at once.
- `defer_target_cents INTEGER` — for `clawback`, the target cumulative refunded to apply on
  retry. NULL for `roll_forward`.
- `defer_attempts INTEGER NOT NULL DEFAULT 0` — incremented each time the tip defers; drives the
  hot-loop mute (§3.4).

Add a partial index so the sweep stays cheap: `CREATE INDEX IF NOT EXISTS idx_tips_deferred ON
tips (deferred_at) WHERE deferred_at IS NOT NULL;`.

### 3.2 Set the marker on defer (guarded)
In **both** defer branches (`payrollLateTip.js:85-96`, `payrollClawback.js:98-108`): keep the
existing `ROLLBACK` (it only discards the no-op period upsert) and the Sentry warning. Then
persist the marker on a **fresh connection** (`pool.query`), with all three guards:

1. **Anti-resurrection guard (Blocker — prevents double-pay):** the UPDATE must only fire if the
   tip is still genuinely unplaced, so a placement that committed between the ROLLBACK and this
   write is never re-marked:
   - Late tip: `UPDATE tips SET deferred_at = COALESCE(deferred_at, NOW()), defer_kind = 'roll_forward', defer_attempts = defer_attempts + 1 WHERE id = $1 AND rolled_forward_at IS NULL`.
   - Clawback: `UPDATE tips SET deferred_at = COALESCE(deferred_at, NOW()), defer_kind = 'clawback', defer_target_cents = $2, defer_attempts = defer_attempts + 1 WHERE id = $1 AND refunded_amount_cents < $2` (`$2 = newAmt`, the clamped target; the `<` guard means a clawback already applied to that cumulative won't be re-marked).
2. **Failure guard (Blocker):** wrap the marker write in try/catch; on failure, `Sentry.captureException` with a distinct tag (`step: 'defer_mark_failed'`) so an invisible strand is at least alerted. The function still returns null (caller behavior unchanged).
3. **Mutual-exclusion (Warning #4):** the late-tip defer UPDATE must not clobber an existing
   `clawback` kind, and vice versa — but per §3.6 a clawback on a not-yet-placed tip never
   reaches the negative-line path, so the only writer of `defer_kind='clawback'` is a clawback on
   a *placed* tip. A `roll_forward`-deferred (never-placed) tip therefore never acquires a
   `clawback` marker. The UPDATE may additionally guard `AND (defer_kind IS NULL OR defer_kind = '<thiskind>')` for defense in depth.

`COALESCE(deferred_at, NOW())` keeps the original age across re-defers.

### 3.3 Clear the marker on success (atomic)
When placement succeeds, clear the marker **in the same transaction** as the existing success
write (atomic with the placement — no window where money landed but the marker stayed):
- Late tip (`payrollLateTip.js:150`): add `deferred_at = NULL, defer_kind = NULL, defer_attempts = 0`
  to `UPDATE tips SET rolled_forward_at = NOW()`. Same clear on the "no bartenders at all"
  permanent-success path (`:55`).
- Clawback (`payrollClawback.js:157`): add `deferred_at = NULL, defer_kind = NULL, defer_target_cents = NULL, defer_attempts = 0`
  to `UPDATE tips SET refunded_amount_cents = $1`. Same clear on the no-shift / no-bartenders
  commit paths (`:40`, `:59`) — including clearing a stale `defer_target_cents` there.

### 3.4 The retry sweep (new util)
`server/utils/payrollDeferredRetry.js` exporting `retryDeferredTips()`:
```
SELECT id, defer_kind, defer_target_cents FROM tips
 WHERE deferred_at IS NOT NULL AND defer_attempts < MAX_DEFER_ATTEMPTS
 ORDER BY deferred_at ASC LIMIT SWEEP_LIMIT
```
(`MAX_DEFER_ATTEMPTS` ~ a small constant, e.g. 25; `SWEEP_LIMIT` ~ 200.) For each row, dispatch
by `defer_kind`: `rollForwardLateTip(id)` or `clawbackTip(id, Number(defer_target_cents))`. Both
are idempotent and re-defer (incrementing `defer_attempts`) if today's period is still frozen.
Wrap each call in try/catch → Sentry, continue the loop. **Return a summary**
`{ scanned, placed, redeferred, errors }`, and emit one info-level Sentry breadcrumb/log per
sweep with those counts. A tip that exceeds `MAX_DEFER_ATTEMPTS` drops out of the auto-sweep but
**remains on the admin list** (flagged "stuck") so it never silently vanishes.

### 3.5 Auto-retry hook
At the **tail of `accruePayoutsForProposal`** (`server/utils/payrollAccrual.js`, after the
successful accrual `COMMIT` at `:273`, on the success-return path only), fire the sweep
**off the response path** so it never delays the accrual caller and never fails the accrual:
`setImmediate(() => retryDeferredTips().catch(err => Sentry.captureException(err, { tags: { util: 'payrollAccrual', step: 'deferred_sweep' } })))`.
(`retryDeferredTips` → `rollForwardLateTip`/`clawbackTip` never re-enter accrual, so no
recursion.) The sweep is not fired on the early skip-return paths (legacy-stub `:87`,
pay_period-not-open `:112`, no-workers `:130`).

### 3.6 Clawback on a never-placed tip (the wrong-claw fix, Warning #4)
A refund can arrive for a tip that is still `roll_forward`-deferred (never placed). Clawing a
negative adjustment then would hit a payout line that does not exist. Rule: before `clawbackTip`
creates a negative line, it must confirm the tip was actually placed — i.e. `rolled_forward_at
IS NOT NULL` **or** a positive `payout_events` line exists for `(tip.shift_id)` carrying this
tip's card-tip cents. If the tip was **never placed**:
- record the refund (`refunded_amount_cents = newAmt`), **no negative line**;
- clear any `roll_forward` deferral marker and set `rolled_forward_at = NOW()` so the pending
  roll-forward is cancelled (a refunded tip must not later be paid forward);
- COMMIT; return `{ delta, bartenders: 0, unplaced: true }`.
This makes `roll_forward` and `clawback` markers mutually exclusive by construction.

### 3.7 Pre-ship strands (Blocker #3 — explicit decision: no automated backfill)
Tips stranded **before** this ships carry no marker, so the sweep won't see them. **An
automated backfill is unsafe and is out of scope**, for a concrete reason: a late-tip strand is
indistinguishable in the schema from a normally-accrued tip (`rolled_forward_at IS NULL,
shift_id IS NOT NULL` describes both), and blindly re-running `rollForwardLateTip` on those
would **double-pay** every normally-accrued tip. Pre-ship strands are therefore resolved
**manually** from the existing Sentry `defer_frozen_today` warning history (the admin re-runs
the matching tip via the admin panel once it ships, or places a manual adjustment). Going
forward, the marker makes every new strand visible. (Clawback strands are delta-idempotent and
could in principle be re-driven from Stripe, but that too is deferred to manual.)

## 4. Money invariants (non-negotiable)
- **No double-pay / no resurrection:** the marker is cleared atomically with the placement, and
  the defer-marker UPDATE is guarded (`rolled_forward_at IS NULL` / `refunded_amount_cents < target`)
  so a placement that commits during the defer-mark race is never re-flagged. The underlying
  functions remain idempotent (`rolled_forward_at`; `refunded_amount_cents` delta).
- **No wrong-claw:** a refund on a never-placed tip records the refund and cancels the
  roll-forward without a negative line (§3.6).
- **Attribution preserved:** the synthetic `payout_events` row references the **original**
  `shift_id`; never a flat unattributed adjustment.
- **Existing rules intact:** legacy-cc-stub filtering, even split, pro-rata fee netting (latest
  `fee_cents`, which may be re-captured between defer and retry — latest wins, which is correct),
  and the funded/floor logic are unchanged.
- **Clawback can't over-withdraw:** target clamped (`min(newCumulative, original)`); only the
  delta beyond `refunded_amount_cents` applied — unchanged.
- **Auth:** the new admin endpoints are `auth + adminOnly` (they move money).

## 5. Edge cases & states
- **No deferred tips:** sweep no-ops; admin panel hidden.
- **Period still frozen on retry:** re-defers, `deferred_at` preserved (COALESCE),
  `defer_attempts++`, age grows; stays on the list.
- **Stuck tip (> MAX_DEFER_ATTEMPTS):** dropped from auto-sweep, kept on the admin list flagged
  "stuck," so it stays visible.
- **Escalating refund while deferred:** `defer_target_cents` updates to the latest cumulative
  (the `< $2` guard still permits the larger target); the retry claws to it.
- **Refund on a `roll_forward`-deferred tip:** §3.6 — recorded, roll-forward cancelled, no line.
- **All-stubs on retry:** stays deferred and visible (resolution needs de-stubbing). The admin
  list distinguishes "stuck on stubs" from "stuck on frozen period" so Retry isn't clicked in
  vain.
- **Marker-write failure:** Sentry `defer_mark_failed`; the strand is alerted even though
  invisible in the table.
- **Concurrent sweeps (two accruals, or accrual + admin Retry):** the placement `FOR UPDATE`
  lock serializes them; the second pass no-ops (marker already cleared).

## 6. Verification
New `server/utils/payrollDeferredRetry.test.js` (node:test, dev DB, self-managing its own
periods like the lateTip/clawback suites — seed a frozen "today" then an open period):
- late tip defers when today is frozen → marker set, `defer_attempts=1`, no payout row → appears
  in `GET /payroll/deferred-tips` → `retryDeferredTips()` (and the accrual hook) place it, clear
  the marker, idempotent on a second call;
- **race:** a placement that commits between the defer ROLLBACK and the marker UPDATE does **not**
  leave the tip marked (the `rolled_forward_at IS NULL` guard holds) — assert no double-pay;
- **marker-write failure** path captures Sentry and still returns null;
- clawback defers → marker + `defer_target_cents` set → retry applies the negative adjustment,
  clears the marker;
- **refund on a `roll_forward`-deferred tip** records the refund, cancels the roll-forward, makes
  no negative line (§3.6);
- escalating refund while deferred raises `defer_target_cents`;
- stuck tip past `MAX_DEFER_ATTEMPTS` drops from the sweep but stays in the list;
- all-stubs → de-stub → retry succeeds and clears the marker.

Run from repo root (loads root `.env`), payroll suites one at a time; re-run
`payrollLateTip.test.js`, `payrollClawback.test.js`, `payrollAccrual.test.js` for no regression.

## 7. Admin "Deferred tips" panel (UI states)
- **`GET /payroll/deferred-tips`** (mirror `/payroll/unassigned-tips` at
  `server/routes/admin/payroll.js:314`, `auth + adminOnly`): rows where `deferred_at IS NOT NULL`,
  joined to `shifts` → `proposals` and the shift bartenders; per item: tip id, kind, amount (+
  target for clawback), event, staff name(s), `deferred_at` (age), `defer_attempts`, and a
  `stuck_reason` ('frozen_period' | 'stubs' | 'max_attempts'). Sorted `deferred_at ASC`.
- **`POST /payroll/deferred-tips/retry`** (`auth + adminOnly`): runs `retryDeferredTips()`,
  returns the `{ scanned, placed, redeferred, errors }` summary **and** the refreshed list.
- **Client `DeferredTipsPanel`** (mirror `client/src/pages/admin/payroll/UnassignedTipsPanel.js`,
  API via `client/src/utils/api.js`): rendered only when the list is non-empty; enumerated
  states — loading spinner, GET-error message, in-flight (Retry disabled + spinner), result
  toast ("placed K of N; D still frozen" / all-frozen / error), client-side debounce on Retry.
  Each row shows event · staff · $amount · kind · age, and visually flags "stuck on stubs" vs
  "frozen period" so the operator knows when Retry won't help.

## 8. Files
- `server/db/schema.sql` — 4 `tips` columns + partial index.
- `server/utils/payrollLateTip.js` — guarded defer marker; clear on success.
- `server/utils/payrollClawback.js` — guarded defer marker (+ target); clear on success;
  never-placed no-line path (§3.6).
- `server/utils/payrollDeferredRetry.js` — **new** `retryDeferredTips()`.
- `server/utils/payrollAccrual.js` — `setImmediate` sweep after successful accrual.
- `server/routes/admin/payroll.js` — `GET /payroll/deferred-tips`, `POST /payroll/deferred-tips/retry`.
- `client/src/pages/admin/payroll/DeferredTipsPanel.js` — **new** panel + payroll-page wiring.
- `server/utils/payrollDeferredRetry.test.js` — **new** tests.
- (Docs) `ARCHITECTURE.md` route table + `tips` schema section; `README.md` folder tree.
