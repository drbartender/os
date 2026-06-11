# Late-Tip / Clawback Recovery — Frozen-Period Strand Fix

- **Date:** 2026-06-11
- **Branch / worktree:** `late-tip-recovery`
- **Status:** Approved design, ready for implementation plan
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

Two facts that shape the design (verified in code):
- **The deferred state is not derivable.** A normal tip paid via `accruePayoutsForProposal`
  also has `rolled_forward_at IS NULL` — that column is set **only** by `rollForwardLateTip`.
  So "deferred" needs its own explicit marker.
- **A deferred clawback loses its target.** `clawbackTip(tipId, newCumulativeRefundedCents)`
  takes the target cumulative as an argument and, on defer, rolls back **without advancing**
  `refunded_amount_cents` and **without storing** the target. The Stripe webhook
  (`clawbackTipByPaymentIntent`) treats the null return as success (HTTP 200), so Stripe does
  **not** re-deliver. The target amount is lost — a retry can't know how much to claw. The
  marker must therefore persist the target for the clawback case.

### Decisions locked during design
- **Resolution trigger = Option A:** auto-retry piggybacks on accrual **+** a manual admin
  "Retry" button. **No new scheduler.** The admin "Deferred tips" list closes the only hole in
  A (a dead week with no accruals) by making any strand visible and one-click-resolvable.
- **Fix the clawback twin in the same pass** — one marker + one sweep, both directions.

## 2. Scope

- `server/db/schema.sql` — three idempotent columns on `tips` (the deferral marker).
- `server/utils/payrollLateTip.js` — set the marker on defer; clear it on success.
- `server/utils/payrollClawback.js` — set the marker (+ target) on defer; clear it on success.
- `server/utils/payrollDeferredRetry.js` — **new** `retryDeferredTips()` sweep.
- `server/utils/payrollAccrual.js` — call the sweep best-effort after a successful accrual.
- `server/routes/admin/payroll.js` — `GET /payroll/deferred-tips` + a retry endpoint.
- `client/src/pages/admin/payroll/` — a "Deferred tips" panel with a Retry button.
- Tests — `server/utils/payrollDeferredRetry.test.js` (+ defer/clear coverage in the
  lateTip/clawback suites).

### Non-goals
- No dedicated retry scheduler/cron (Option B rejected).
- No change to how tips normally accrue (`accruePayoutsForProposal`), match shifts, or compute
  shares/fees/floors.
- No auto-resolution of the `all_bartenders_are_legacy_cc_stubs` case (a retry that hits
  all-stubs stays deferred and visible; resolving it requires de-stubbing — out of scope).
- No manual-placement / flat-adjustment admin fallback in v1 (auto-roll + retry covers it).

## 3. Requirements

### 3.1 The deferral marker (schema)
Add to `tips` at the ALTER block (`server/db/schema.sql` ~`:2693`, idempotent
`ADD COLUMN IF NOT EXISTS`):
- `deferred_at TIMESTAMPTZ` — set when placement defers, cleared (NULL) on success. NULL means
  "not deferred." Drives the sweep query, the admin list, and item age.
- `defer_kind TEXT` — `'roll_forward'` | `'clawback'`. Tells the sweep which function to call.
- `defer_target_cents INTEGER` — for `clawback`, the target cumulative refunded amount to apply
  on retry. NULL for `roll_forward` (the amount is already on the tip row).

### 3.2 Set the marker on defer
In **both** defer branches (`payrollLateTip.js:85-96`, `payrollClawback.js:98-108`): keep the
existing `ROLLBACK` (it only discards the no-op period upsert) and the Sentry warning, then
persist the marker on a **fresh connection** (`pool.query`, since the transaction was rolled
back). Use `COALESCE(deferred_at, NOW())` so re-defers preserve the original age.
- Late tip: `UPDATE tips SET deferred_at = COALESCE(deferred_at, NOW()), defer_kind = 'roll_forward' WHERE id = $1`.
- Clawback: `UPDATE tips SET deferred_at = COALESCE(deferred_at, NOW()), defer_kind = 'clawback', defer_target_cents = $2 WHERE id = $1` (with `$2 = newAmt`, the clamped target cumulative). `defer_target_cents` is **always** set to the latest target, so an escalating refund arriving while deferred raises it correctly.

### 3.3 Clear the marker on success
When placement succeeds, clear the marker in the **same transaction** as the existing success
write (so it's atomic with the placement — no window where money landed but the marker stayed):
- Late tip (`payrollLateTip.js:150`): add `deferred_at = NULL, defer_kind = NULL` to the
  `UPDATE tips SET rolled_forward_at = NOW()`. Also clear on the "no bartenders at all"
  permanent-success path (`:55`).
- Clawback (`payrollClawback.js:157`): add `deferred_at = NULL, defer_kind = NULL, defer_target_cents = NULL` to the `UPDATE tips SET refunded_amount_cents = $1`. Also clear on the no-shift / no-bartenders commit paths (`:40`, `:59`).

### 3.4 The retry sweep (new util)
`server/utils/payrollDeferredRetry.js` exporting `retryDeferredTips()`:
```
SELECT id, defer_kind, defer_target_cents FROM tips WHERE deferred_at IS NOT NULL
```
For each row, dispatch by `defer_kind`: `rollForwardLateTip(id)` or
`clawbackTip(id, Number(defer_target_cents))`. Both are already idempotent (late tip no-ops if
`rolled_forward_at` set; clawback no-ops if delta ≤ 0) and re-defer (marker preserved via
COALESCE) if today's period is still frozen. Wrap each call in try/catch → Sentry, continue the
loop (one bad tip must not abort the rest). Returns a summary count.

### 3.5 Auto-retry hook
At the **tail of `accruePayoutsForProposal`** (`server/utils/payrollAccrual.js`), after the
successful accrual COMMIT and before returning the success result, call
`retryDeferredTips()` **best-effort**: `await retryDeferredTips().catch(err => Sentry.captureException(err, { tags: { util: 'payrollAccrual', step: 'deferred_sweep' } }))`.
A sweep failure must **never** fail the accrual that just succeeded. Because an accrual only
reaches this point with an open period, the deferred tips now have somewhere to land. (The
sweep is not run on the early skip-return paths — legacy-stub, pay_period-not-open, no-workers.)

### 3.6 Admin "Deferred tips" panel
- **`GET /payroll/deferred-tips`** (`server/routes/admin/payroll.js`, mirror the
  `/payroll/unassigned-tips` handler at `:314`, `auth + adminOnly`): list rows where
  `deferred_at IS NOT NULL`, joined to `shifts` → `proposals` (event label/date) and the
  bartenders on the shift, returning per item: tip id, kind, amount (and target for clawback),
  event, staff name(s), `deferred_at` (for age).
- **Retry endpoint** (`POST /payroll/deferred-tips/retry`, `auth + adminOnly`): call
  `retryDeferredTips()`, then return the refreshed list. (One "Retry now" sweeps all — simplest;
  per-tip retry is unnecessary in v1.)
- **Client:** a `DeferredTipsPanel` in the payroll page (mirror `UnassignedTipsPanel.js`),
  rendered only when the list is non-empty, showing each item (event · staff · $amount · kind ·
  age) and a single **Retry now** button that POSTs the retry endpoint and refreshes. API calls
  go through `client/src/utils/api.js`.

## 4. Money invariants (non-negotiable)
- **Idempotent retry, no double-pay:** the marker is cleared in the same transaction as the
  placement; the underlying functions already guard (late tip via `rolled_forward_at`, clawback
  via `refunded_amount_cents` delta). A retry of an already-placed item no-ops.
- **Attribution preserved:** the synthetic `payout_events` row still references the **original**
  `shift_id` so the line labels back to its true event; never a flat unattributed adjustment.
- **Existing rules intact:** legacy-cc-stub filtering, even split, pro-rata fee netting, and the
  funded/floor logic are unchanged — the retry just re-invokes the same placement code.
- **Clawback can't over-withdraw:** the target is clamped (`min(newCumulative, original)`) and
  only the delta beyond `refunded_amount_cents` is applied — unchanged.
- **Sentry stays as a backstop alert**, but is no longer the *only* signal that a strand exists.

## 5. Edge cases
- **No deferred tips:** sweep no-ops; the admin panel is hidden (empty list).
- **Period still frozen on retry:** the placement re-defers; `deferred_at` is preserved
  (COALESCE), age grows; item stays in the list.
- **Escalating refund while deferred:** a second, larger refund updates `defer_target_cents` to
  the latest cumulative; the eventual retry claws to that amount.
- **All-stubs on retry:** the late-tip/clawback all-stub skip leaves the tip deferred and
  visible (resolution needs de-stubbing — out of scope).
- **Concurrency:** placement locks the tip `FOR UPDATE`; the sweep iterates serially. A retry
  racing a real-time webhook for the same tip is serialized by the row lock and idempotency.

## 6. Verification
- New `server/utils/payrollDeferredRetry.test.js` (node:test, dev DB, self-managing its own
  pay periods like the lateTip/clawback suites — seed a frozen "today" then an open period):
  - late tip defers when today is frozen → `deferred_at`/`defer_kind` set, no payout row;
  - it appears in the `GET /payroll/deferred-tips` result;
  - `retryDeferredTips()` (and the accrual hook) place it into the open period, clear the marker,
    and are idempotent on a second call;
  - clawback defers → marker + `defer_target_cents` set → retry applies the negative adjustment
    and clears the marker;
  - escalating refund while deferred raises `defer_target_cents`.
- `cd .. && node --test server/utils/payrollDeferredRetry.test.js` from the repo root (loads the
  root `.env`); run payroll suites one at a time (shared dev DB).
- Re-run `server/utils/payrollLateTip.test.js`, `payrollClawback.test.js`,
  `payrollAccrual.test.js` to confirm no regression in the existing placement paths.

## 7. Files
- `server/db/schema.sql` — 3 `tips` columns (deferral marker).
- `server/utils/payrollLateTip.js` — set marker on defer, clear on success.
- `server/utils/payrollClawback.js` — set marker (+ target) on defer, clear on success.
- `server/utils/payrollDeferredRetry.js` — **new** `retryDeferredTips()`.
- `server/utils/payrollAccrual.js` — best-effort sweep after successful accrual.
- `server/routes/admin/payroll.js` — `GET /payroll/deferred-tips`, `POST /payroll/deferred-tips/retry`.
- `client/src/pages/admin/payroll/DeferredTipsPanel.js` — **new** panel + wiring into the payroll page.
- `server/utils/payrollDeferredRetry.test.js` — **new** tests.
- (Docs) `ARCHITECTURE.md` route table + the `tips` schema section; `README.md` folder tree for
  the new files.
