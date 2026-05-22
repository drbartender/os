# Staff Payment System — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the data model and the pure payout-computation engine for the staff payment system, plus the accrual hook that creates payout records when an event completes.

**Architecture:** Three new tables (`pay_periods`, `payouts`, `payout_events`) plus fee/match columns on `tips` and `proposal_payments`, all appended idempotently to `schema.sql`. A pure, unit-tested computation layer (`payrollPeriods.js`, `payrollMath.js`) holds all money and date math with no DB access, mirroring `pricingEngine.js`. Two DB modules (`payrollTips.js`, `payrollAccrual.js`) orchestrate the pure functions against the database. Accrual is triggered from the existing event-completion runner and the manual completion route.

**Tech Stack:** Node.js / Express, raw SQL via `pg` (`pool.query`, parameterized), Node's built-in test runner (`node:test` + `node:assert/strict`). No ORM, no Jest.

**Scope:** Phase 1 of 4 (design spec, Section 16). It produces a working, tested backend: the schema and a computation engine that fills payout records as events complete. The admin portal (Phase 2), staff side (Phase 3), and notifications plus document updates (Phase 4) are separate plans, written when their turn comes.

**Spec:** `docs/superpowers/specs/2026-05-22-staff-payment-system-design.md`

---

## File Structure

**Created:**
- `server/utils/payrollPeriods.js` — pure: pay-period boundaries (Tuesday-to-Monday), US federal holiday calendar, working-day test, payday computation.
- `server/utils/payrollPeriods.test.js` — unit tests.
- `server/utils/payrollMath.js` — pure: contracted hours, wage, even-split with remainder distribution, gratuity extraction, pro-rata fee, tip-to-shift window matching.
- `server/utils/payrollMath.test.js` — unit tests.
- `server/utils/payrollTips.js` — DB: capture a tip's real Stripe fee, match a tip to its shift.
- `server/utils/payrollTips.test.js` — integration tests.
- `server/utils/payrollAccrual.js` — DB: `accruePayoutsForProposal(proposalId)`, idempotent.
- `server/utils/payrollAccrual.test.js` — integration tests.

**Modified:**
- `server/db/schema.sql` — append three tables, the `tips` and `proposal_payments` columns, indexes.
- `package.json` — add a `test` script.
- `server/utils/balanceScheduler.js` — call `accruePayoutsForProposal` in the `processEventCompletions` loop.
- `server/routes/stripe.js` — in the tip webhook, capture the fee and match the tip after the tip row is inserted.
- `server/routes/proposals/lifecycle.js` — call `accruePayoutsForProposal` on a manual transition to `completed`.

Pure functions never touch the database and unit-test in isolation. DB modules are thin orchestrators over the pure functions, integration-tested against a real database following the `server/utils/marketingHandlers.test.js` pattern. Integration tests require `DATABASE_URL` in `.env`.

---

## Task 1: Add the test script

**Files:**
- Modify: `package.json` (the `scripts` block)

- [ ] **Step 1: Add the script**

In `package.json`, add to `scripts`:

```json
"test": "node --test"
```

- [ ] **Step 2: Verify it runs the existing suite**

Run: `npm test`
Expected: Node's test runner discovers the existing `*.test.js` files and reports pass/fail counts (existing suite passes).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(payroll): add node --test script"
```

---

## Task 2: Schema — payroll tables and fee columns

**Files:**
- Modify: `server/db/schema.sql` (append at end of file)

- [ ] **Step 1: Append the new section**

Append to the very end of `server/db/schema.sql`:

```sql
-- ─── Staff payment system, Phase 1 (2026-05-22) ───
-- Payroll ledger: pay_periods (Tue-Mon windows), payouts (one per contractor
-- per period), payout_events (per-event line items). Plus fee/match columns
-- on tips and proposal_payments for fee-netting and tip-to-event matching.

CREATE TABLE IF NOT EXISTS pay_periods (
  id SERIAL PRIMARY KEY,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  payday DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (start_date)
);

DO $$ BEGIN
  ALTER TABLE pay_periods DROP CONSTRAINT IF EXISTS pay_periods_status_check;
  ALTER TABLE pay_periods ADD CONSTRAINT pay_periods_status_check
    CHECK (status IN ('open', 'processing', 'paid'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS payouts (
  id SERIAL PRIMARY KEY,
  pay_period_id INTEGER NOT NULL REFERENCES pay_periods(id),
  contractor_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending',
  total_cents INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,
  payment_handle TEXT,
  paid_at TIMESTAMPTZ,
  paid_by INTEGER REFERENCES users(id),
  paystub_storage_key TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (pay_period_id, contractor_id)
);

DO $$ BEGIN
  ALTER TABLE payouts DROP CONSTRAINT IF EXISTS payouts_status_check;
  ALTER TABLE payouts ADD CONSTRAINT payouts_status_check
    CHECK (status IN ('pending', 'paid'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS payout_events (
  id SERIAL PRIMARY KEY,
  payout_id INTEGER NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
  shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  contracted_hours NUMERIC(5,2) NOT NULL,
  hours NUMERIC(5,2) NOT NULL,
  rate_cents INTEGER NOT NULL,
  wage_cents INTEGER NOT NULL DEFAULT 0,
  late BOOLEAN NOT NULL DEFAULT FALSE,
  gratuity_share_cents INTEGER NOT NULL DEFAULT 0,
  card_tip_gross_cents INTEGER NOT NULL DEFAULT 0,
  card_tip_fee_cents INTEGER NOT NULL DEFAULT 0,
  card_tip_net_cents INTEGER NOT NULL DEFAULT 0,
  adjustment_cents INTEGER NOT NULL DEFAULT 0,
  adjustment_note TEXT,
  line_total_cents INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (payout_id, shift_id)
);

CREATE INDEX IF NOT EXISTS idx_payouts_pay_period ON payouts(pay_period_id);
CREATE INDEX IF NOT EXISTS idx_payout_events_payout ON payout_events(payout_id);

ALTER TABLE tips ADD COLUMN IF NOT EXISTS fee_cents INTEGER;
ALTER TABLE tips ADD COLUMN IF NOT EXISTS shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tips_shift ON tips(shift_id);

ALTER TABLE proposal_payments ADD COLUMN IF NOT EXISTS fee_cents INTEGER;
```

The `UNIQUE (payout_id, shift_id)` on `payout_events` makes accrual idempotent: re-running it `ON CONFLICT` updates rather than duplicates. The FK delete rules are deliberate: `payout_events.shift_id` is `ON DELETE RESTRICT` — a shift with payroll accrued against it cannot be deleted out from under the ledger — while `tips.shift_id` is `ON DELETE SET NULL`, since a tip is real money that must outlive a shift deletion and simply fall back to unmatched.

- [ ] **Step 2: Apply and verify the schema**

`schema.sql` is re-run in full on every server boot by `initDb()` in `server/db/index.js`. Apply it by running:

```bash
node -e "require('dotenv').config(); require('./server/db').initDb().then(()=>{console.log('schema ok');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"
```

Expected: prints `schema ok`. Then confirm the tables exist:

```bash
node -e "require('dotenv').config(); const {pool}=require('./server/db'); pool.query(\"SELECT to_regclass('public.pay_periods'), to_regclass('public.payouts'), to_regclass('public.payout_events')\").then(r=>{console.log(r.rows[0]);return pool.end()})"
```

Expected: all three values are non-null table names.

- [ ] **Step 3: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(payroll): payroll ledger tables and fee columns"
```

---

## Task 3: payrollPeriods.js — pay-period boundaries

**Files:**
- Create: `server/utils/payrollPeriods.js`
- Test: `server/utils/payrollPeriods.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/utils/payrollPeriods.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { payPeriodForDate } = require('./payrollPeriods');

test('payPeriodForDate > a Tuesday is the start of its own period', () => {
  // 2026-05-26 is a Tuesday.
  assert.deepEqual(payPeriodForDate('2026-05-26'), {
    startDate: '2026-05-26',
    endDate: '2026-06-01',
  });
});

test('payPeriodForDate > a Monday is the end of the period that started the prior Tuesday', () => {
  // 2026-06-01 is a Monday.
  assert.deepEqual(payPeriodForDate('2026-06-01'), {
    startDate: '2026-05-26',
    endDate: '2026-06-01',
  });
});

test('payPeriodForDate > a mid-week day resolves to its enclosing Tue-Mon window', () => {
  // 2026-05-29 is a Friday.
  assert.deepEqual(payPeriodForDate('2026-05-29'), {
    startDate: '2026-05-26',
    endDate: '2026-06-01',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/payrollPeriods.test.js`
Expected: FAIL, cannot find module `./payrollPeriods` (or `payPeriodForDate is not a function`).

- [ ] **Step 3: Write minimal implementation**

Create `server/utils/payrollPeriods.js`:

```js
/**
 * Pure pay-period and payday math for the staff payment system.
 * No DB, no side effects. Mirrors the bookingWindow.js / pricingEngine.js style.
 *
 * A pay period is a Tuesday-to-Monday window. Payday is the second working day
 * on or after the period's Monday end date, counting that Monday when it is a
 * working day. A working day is Monday-Friday excluding US federal holidays.
 *
 * All functions take and return 'YYYY-MM-DD' strings and compute in UTC, so
 * they are free of local-timezone drift.
 */

const MS_PER_DAY = 86400000;

function parseYmd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toYmd(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(ymd, n) {
  return toYmd(new Date(parseYmd(ymd).getTime() + n * MS_PER_DAY));
}

// UTC day index: Sun=0, Mon=1, Tue=2, ... Sat=6.
function dayOfWeek(ymd) {
  return parseYmd(ymd).getUTCDay();
}

/**
 * The Tuesday-to-Monday pay period containing `ymd`.
 * Returns { startDate, endDate } as 'YYYY-MM-DD' strings.
 */
function payPeriodForDate(ymd) {
  const daysSinceTuesday = (dayOfWeek(ymd) - 2 + 7) % 7;
  const startDate = addDays(ymd, -daysSinceTuesday);
  const endDate = addDays(startDate, 6);
  return { startDate, endDate };
}

module.exports = { payPeriodForDate, addDays, parseYmd, toYmd, dayOfWeek };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/payrollPeriods.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/payrollPeriods.js server/utils/payrollPeriods.test.js
git commit -m "feat(payroll): pay-period boundary computation"
```

---

## Task 4: payrollPeriods.js — holidays, working days, payday

**Files:**
- Modify: `server/utils/payrollPeriods.js`
- Modify: `server/utils/payrollPeriods.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/utils/payrollPeriods.test.js`:

```js
const { computePayday, isWorkingDay, usFederalHolidays } = require('./payrollPeriods');

test('isWorkingDay > a normal Tuesday is a working day', () => {
  assert.equal(isWorkingDay('2026-05-26'), true);
});

test('isWorkingDay > a Saturday is not a working day', () => {
  assert.equal(isWorkingDay('2026-05-30'), false);
});

test('usFederalHolidays > Memorial Day 2026 is the last Monday of May', () => {
  assert.ok(usFederalHolidays(2026).has('2026-05-25'));
});

test('isWorkingDay > a federal holiday Monday is not a working day', () => {
  // 2026-05-25 is Memorial Day.
  assert.equal(isWorkingDay('2026-05-25'), false);
});

test('computePayday > normal week: payday is the Tuesday after the closing Monday', () => {
  // Period ends Monday 2026-06-01; that Monday is a working day, Tuesday is payday.
  assert.equal(computePayday('2026-06-01'), '2026-06-02');
});

test('computePayday > Memorial Day week: closing Monday is a holiday, payday slides to Wednesday', () => {
  // Period ends Monday 2026-05-25 (Memorial Day). Tue is working day 1, Wed is payday.
  assert.equal(computePayday('2026-05-25'), '2026-05-27');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/payrollPeriods.test.js`
Expected: FAIL, `computePayday is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `server/utils/payrollPeriods.js`, add these functions before `module.exports`:

```js
// Observed date for a fixed-date holiday: Saturday shifts to Friday,
// Sunday shifts to Monday.
function observed(ymd) {
  const dow = dayOfWeek(ymd);
  if (dow === 6) return addDays(ymd, -1);
  if (dow === 0) return addDays(ymd, 1);
  return ymd;
}

// The nth `weekday` (0=Sun..6=Sat) of `month` (1-12) in `year`.
function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return toYmd(new Date(Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7)));
}

// The last `weekday` of `month` in `year`.
function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return toYmd(new Date(Date.UTC(year, month, 0 - offset)));
}

/** Observed US federal holidays for a year, as a Set of 'YYYY-MM-DD'. */
function usFederalHolidays(year) {
  return new Set([
    observed(`${year}-01-01`),    // New Year's Day
    nthWeekday(year, 1, 1, 3),    // MLK Day
    nthWeekday(year, 2, 1, 3),    // Washington's Birthday
    lastWeekday(year, 5, 1),      // Memorial Day
    observed(`${year}-06-19`),    // Juneteenth
    observed(`${year}-07-04`),    // Independence Day
    nthWeekday(year, 9, 1, 1),    // Labor Day
    nthWeekday(year, 10, 1, 2),   // Columbus Day
    observed(`${year}-11-11`),    // Veterans Day
    nthWeekday(year, 11, 4, 4),   // Thanksgiving
    observed(`${year}-12-25`),    // Christmas
  ]);
}

/** True when `ymd` is Mon-Fri and not an observed federal holiday. */
function isWorkingDay(ymd) {
  const dow = dayOfWeek(ymd);
  if (dow === 0 || dow === 6) return false;
  const year = Number(ymd.slice(0, 4));
  // Check adjacent years too: a New Year observed on Dec 31 lands in the
  // prior year, and one observed on Jan 2 is built for the next year.
  for (const y of [year - 1, year, year + 1]) {
    if (usFederalHolidays(y).has(ymd)) return false;
  }
  return true;
}

/**
 * Payday for a period: the second working day on or after `endDate`
 * (the period's Monday), counting that Monday when it is a working day.
 */
function computePayday(endDate) {
  let d = endDate;
  let working = 0;
  for (let i = 0; i < 14; i++) {
    if (isWorkingDay(d)) {
      working += 1;
      if (working === 2) return d;
    }
    d = addDays(d, 1);
  }
  throw new Error(`computePayday: no payday found near ${endDate}`);
}
```

Update the `module.exports` line to:

```js
module.exports = {
  payPeriodForDate, computePayday, isWorkingDay, usFederalHolidays,
  addDays, parseYmd, toYmd, dayOfWeek,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/payrollPeriods.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/payrollPeriods.js server/utils/payrollPeriods.test.js
git commit -m "feat(payroll): holiday-aware payday computation"
```

---

## Task 5: payrollMath.js — contracted hours and wage

**Files:**
- Create: `server/utils/payrollMath.js`
- Test: `server/utils/payrollMath.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/utils/payrollMath.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { contractedHours, wageCents } = require('./payrollMath');

test('contractedHours > event duration plus 1h setup plus 0.5h breakdown', () => {
  assert.equal(contractedHours(4), 5.5);
  assert.equal(contractedHours(3.5), 5);
});

test('wageCents > exact when hours times rate is a whole number of cents', () => {
  assert.equal(wageCents(5.5, 2000), 11000);   // 5.5h @ $20.00
});

test('wageCents > rounds a fractional-cent result', () => {
  // 5.25 * 2083 = 10935.75, rounds to 10936
  assert.equal(wageCents(5.25, 2083), 10936);
});
```

Both `wageCents` cases assert the same rule: `Math.round(hours * rateCents)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/payrollMath.test.js`
Expected: FAIL, cannot find module `./payrollMath`.

- [ ] **Step 3: Write minimal implementation**

Create `server/utils/payrollMath.js`:

```js
/**
 * Pure payout math for the staff payment system. No DB, no side effects.
 * All money is integer cents. Mirrors the pricingEngine.js style.
 */

const SETUP_HOURS = 1;
const BREAKDOWN_HOURS = 0.5;

/** Contracted time = event duration + 1h setup + 30m breakdown. */
function contractedHours(eventDurationHours) {
  return Number(eventDurationHours) + SETUP_HOURS + BREAKDOWN_HOURS;
}

/** Wage in cents = hours * per-hour rate, rounded to whole cents. */
function wageCents(hours, rateCents) {
  return Math.round(Number(hours) * Number(rateCents));
}

module.exports = { contractedHours, wageCents, SETUP_HOURS, BREAKDOWN_HOURS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/payrollMath.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/utils/payrollMath.js server/utils/payrollMath.test.js
git commit -m "feat(payroll): contracted-hours and wage math"
```

---

## Task 6: payrollMath.js — even split with remainder distribution

**Files:**
- Modify: `server/utils/payrollMath.js`
- Modify: `server/utils/payrollMath.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/utils/payrollMath.test.js`:

```js
const { splitEvenly } = require('./payrollMath');

test('splitEvenly > divides evenly when there is no remainder', () => {
  assert.deepEqual(splitEvenly(10000, 2), [5000, 5000]);
});

test('splitEvenly > hands remainder cents to the earliest shares', () => {
  // 10001 / 3 = 3333 r 2 -> first two shares get the extra cent
  assert.deepEqual(splitEvenly(10001, 3), [3334, 3334, 3333]);
});

test('splitEvenly > shares always sum to the exact total', () => {
  const shares = splitEvenly(9997, 4);
  assert.equal(shares.reduce((a, b) => a + b, 0), 9997);
});

test('splitEvenly > zero recipients yields an empty array', () => {
  assert.deepEqual(splitEvenly(5000, 0), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/payrollMath.test.js`
Expected: FAIL, `splitEvenly is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `server/utils/payrollMath.js`, add before `module.exports`:

```js
/**
 * Split `totalCents` into `n` integer shares. The first `remainder` shares
 * each get one extra cent, so the shares sum to exactly `totalCents` and the
 * result is deterministic. The caller assigns shares to recipients ordered
 * by users.id, per the spec's remainder rule.
 */
function splitEvenly(totalCents, n) {
  if (n <= 0) return [];
  const base = Math.floor(totalCents / n);
  const remainder = totalCents - base * n;
  const shares = [];
  for (let i = 0; i < n; i += 1) {
    shares.push(base + (i < remainder ? 1 : 0));
  }
  return shares;
}
```

Add `splitEvenly` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/payrollMath.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/utils/payrollMath.js server/utils/payrollMath.test.js
git commit -m "feat(payroll): deterministic even-split with remainder"
```

---

## Task 7: payrollMath.js — gratuity extraction and pro-rata fee

**Files:**
- Modify: `server/utils/payrollMath.js`
- Modify: `server/utils/payrollMath.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/utils/payrollMath.test.js`:

```js
const { extractGratuityCents, proRataFeeCents } = require('./payrollMath');

test('extractGratuityCents > sums every Shared Gratuity breakdown line', () => {
  const snapshot = { breakdown: [
    { label: 'Package', amount: 800 },
    { label: 'Shared Gratuity', amount: 150 },
    { label: 'Shared Gratuity', amount: 50 },
  ] };
  assert.equal(extractGratuityCents(snapshot), 20000); // (150 + 50) dollars
});

test('extractGratuityCents > returns 0 when there is no gratuity line', () => {
  assert.equal(extractGratuityCents({ breakdown: [{ label: 'Package', amount: 800 }] }), 0);
});

test('extractGratuityCents > tolerates a missing or empty snapshot', () => {
  assert.equal(extractGratuityCents(null), 0);
  assert.equal(extractGratuityCents({}), 0);
});

test('proRataFeeCents > the gratuity slice carries its share of the payment fee', () => {
  // gratuity 20000 of a 100000 payment that cost 3200 in fees -> 640
  assert.equal(proRataFeeCents(20000, 100000, 3200), 640);
});

test('proRataFeeCents > returns 0 when the payment total is 0 (non-card payment)', () => {
  assert.equal(proRataFeeCents(20000, 0, 0), 0);
});

test('proRataFeeCents > clamps the ratio at 1 so a slice never over-nets the fee', () => {
  // A slice larger than the payment total must still carry at most the whole fee.
  assert.equal(proRataFeeCents(150000, 100000, 3200), 3200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/payrollMath.test.js`
Expected: FAIL, `extractGratuityCents is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `server/utils/payrollMath.js`, add before `module.exports`:

```js
/**
 * Total gratuity in cents from a proposal pricing snapshot. `breakdown` is an
 * array of { label, amount } with amount in dollars; there can be zero, one,
 * or several 'Shared Gratuity' lines, so sum them all.
 */
function extractGratuityCents(pricingSnapshot) {
  const breakdown = (pricingSnapshot && pricingSnapshot.breakdown) || [];
  let dollars = 0;
  for (const line of breakdown) {
    if (line && line.label === 'Shared Gratuity') {
      dollars += Number(line.amount) || 0;
    }
  }
  return Math.round(dollars * 100);
}

/**
 * The card-fee share attributable to a `grossCents` slice of a card payment
 * of `paymentTotalCents` that incurred `paymentFeeCents` in fees. Returns 0
 * when nothing was charged on a card.
 */
function proRataFeeCents(grossCents, paymentTotalCents, paymentFeeCents) {
  if (!paymentTotalCents || paymentTotalCents <= 0) return 0;
  // Clamp the ratio at 1: a slice can never carry more than the whole fee.
  // The gratuity slice should always be <= the payment total, but data drift
  // between pricing_snapshot and total_price must never over-net the fee.
  const ratio = Math.min(1, grossCents / paymentTotalCents);
  return Math.round(Number(paymentFeeCents) * ratio);
}
```

Add both to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/payrollMath.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/utils/payrollMath.js server/utils/payrollMath.test.js
git commit -m "feat(payroll): gratuity extraction and pro-rata fee math"
```

---

## Task 8: payrollMath.js — tip-to-shift window matching

**Files:**
- Modify: `server/utils/payrollMath.js`
- Modify: `server/utils/payrollMath.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/utils/payrollMath.test.js`:

```js
const { matchTipToShift } = require('./payrollMath');

const windows = [
  { shiftId: 10, startMs: 1000, endMs: 5000 },
  { shiftId: 20, startMs: 8000, endMs: 12000 },
];

test('matchTipToShift > returns the shift whose window contains the tip', () => {
  assert.equal(matchTipToShift(3000, windows), 10);
  assert.equal(matchTipToShift(9000, windows), 20);
});

test('matchTipToShift > returns null when no window contains the tip', () => {
  assert.equal(matchTipToShift(6000, windows), null);
});

test('matchTipToShift > on overlap, picks the window whose start is nearest', () => {
  const overlap = [
    { shiftId: 1, startMs: 0, endMs: 10000 },
    { shiftId: 2, startMs: 7000, endMs: 20000 },
  ];
  assert.equal(matchTipToShift(8000, overlap), 2); // 8000 is nearer 7000 than 0
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/payrollMath.test.js`
Expected: FAIL, `matchTipToShift is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `server/utils/payrollMath.js`, add before `module.exports`:

```js
/**
 * Pick the shift a tip belongs to. `shiftWindows` is an array of
 * { shiftId, startMs, endMs } service windows in epoch milliseconds.
 * Returns the shiftId whose window contains `tippedAtMs`; on overlap, the
 * one whose start is nearest the tip; null when none contain it.
 */
function matchTipToShift(tippedAtMs, shiftWindows) {
  let best = null;
  let bestDistance = Infinity;
  for (const w of shiftWindows) {
    if (tippedAtMs >= w.startMs && tippedAtMs <= w.endMs) {
      const distance = Math.abs(tippedAtMs - w.startMs);
      if (distance < bestDistance) {
        best = w.shiftId;
        bestDistance = distance;
      }
    }
  }
  return best;
}
```

Add `matchTipToShift` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/payrollMath.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/utils/payrollMath.js server/utils/payrollMath.test.js
git commit -m "feat(payroll): tip-to-shift window matching"
```

---

## Task 9: payrollTips.js — Stripe fee capture and tip matching

**Files:**
- Create: `server/utils/payrollTips.js`
- Test: `server/utils/payrollTips.test.js`

This module touches the DB and Stripe, so it is integration-tested against a real database (the `marketingHandlers.test.js` pattern). The Stripe fee-capture functions are exercised manually, not in the automated test; the test covers `matchTipToEvent`, which is pure DB.

- [ ] **Step 1: Write the failing test**

Create `server/utils/payrollTips.test.js`:

```js
require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { matchTipToEvent } = require('./payrollTips');

let userId, proposalId, shiftId;

before(async () => {
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('tipmatch@example.com','x','staff') RETURNING id"
  );
  userId = u.rows[0].id;
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours)
     VALUES (NULL, CURRENT_DATE, 'completed', 'birthday-party', '6:00 PM', 4) RETURNING id`
  );
  proposalId = p.rows[0].id;
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id, event_duration_hours)
     VALUES (CURRENT_DATE, '6:00 PM', 'open', $1, 4) RETURNING id`,
    [proposalId]
  );
  shiftId = s.rows[0].id;
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,'Bartender','approved')",
    [shiftId, userId]
  );
});

afterEach(async () => {
  await pool.query('DELETE FROM tips WHERE target_user_id = $1', [userId]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('matchTipToEvent > sets shift_id when the tip falls in the event window', async () => {
  // A tip during the event (event starts 6:00 PM today).
  const tip = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, stripe_payment_intent_id, tipped_at)
     VALUES (gen_random_uuid(), $1, 5000, 'pi_match_1', CURRENT_DATE + TIME '19:30') RETURNING id`,
    [userId]
  );
  await matchTipToEvent(tip.rows[0].id);
  const { rows } = await pool.query('SELECT shift_id FROM tips WHERE id = $1', [tip.rows[0].id]);
  assert.equal(rows[0].shift_id, shiftId);
});

test('matchTipToEvent > leaves shift_id null when the tip is far outside any window', async () => {
  const tip = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, stripe_payment_intent_id, tipped_at)
     VALUES (gen_random_uuid(), $1, 5000, 'pi_match_2', CURRENT_DATE - INTERVAL '10 days') RETURNING id`,
    [userId]
  );
  await matchTipToEvent(tip.rows[0].id);
  const { rows } = await pool.query('SELECT shift_id FROM tips WHERE id = $1', [tip.rows[0].id]);
  assert.equal(rows[0].shift_id, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/payrollTips.test.js`
Expected: FAIL, `matchTipToEvent is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `server/utils/payrollTips.js`:

```js
/**
 * DB-side tip helpers for payroll: match a tip to the shift (event) it belongs
 * to, and capture the real Stripe processing fee for tips and proposal
 * payments. Fee capture runs at accrual time, not in the tip webhook: when the
 * webhook fires the Stripe charge has usually not settled, so the
 * balance-transaction fee is not yet available.
 */
const { pool } = require('../db');
const Sentry = require('@sentry/node');
const { getStripe } = require('./stripeClient');
const { matchTipToShift } = require('./payrollMath');

const POST_GRACE = "INTERVAL '3 hours'";

/**
 * The actual Stripe processing fee for a payment intent, in cents, or null
 * when the charge has not settled yet (no balance transaction available).
 */
async function stripeFeeFor(paymentIntentId) {
  const stripe = getStripe();
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ['latest_charge.balance_transaction'],
  });
  const fee = pi
    && pi.latest_charge
    && pi.latest_charge.balance_transaction
    && pi.latest_charge.balance_transaction.fee;
  return fee == null ? null : fee;
}

/**
 * Match a tip to the shift whose service window contains tipped_at, among the
 * shifts the tipped bartender worked. Sets tips.shift_id, or leaves it NULL
 * (unassigned) when no window matches. Called from the tip webhook.
 *
 * The service window runs from the event's setup start (event start minus the
 * shift's setup lead) to 3 hours after the scheduled end, computed in the
 * event's own timezone. ORDER BY s.id makes the overlap tie-break deterministic.
 */
async function matchTipToEvent(tipId) {
  const tipRes = await pool.query(
    'SELECT target_user_id, tipped_at FROM tips WHERE id = $1',
    [tipId]
  );
  const tip = tipRes.rows[0];
  if (!tip) return;

  const windowRes = await pool.query(
    `SELECT s.id AS shift_id,
            EXTRACT(EPOCH FROM (
              ((p.event_date + p.event_start_time::time)
                  AT TIME ZONE COALESCE(p.event_timezone, 'America/Chicago'))
                - (COALESCE(s.setup_minutes_before, 60) || ' minutes')::interval
            )) * 1000 AS start_ms,
            EXTRACT(EPOCH FROM (
              ((p.event_date + p.event_start_time::time)
                  AT TIME ZONE COALESCE(p.event_timezone, 'America/Chicago'))
                + (COALESCE(p.event_duration_hours, 0) || ' hours')::interval
                + ${POST_GRACE}
            )) * 1000 AS end_ms
     FROM shift_requests sr
     JOIN shifts s ON s.id = sr.shift_id
     JOIN proposals p ON p.id = s.proposal_id
     WHERE sr.user_id = $1
       AND sr.status = 'approved'
       AND p.event_start_time ~* '^[0-9]{1,2}:[0-9]{2}( ?[AP]M)?$'
     ORDER BY s.id`,
    [tip.target_user_id]
  );

  const windows = windowRes.rows.map(r => ({
    shiftId: r.shift_id,
    startMs: Number(r.start_ms),
    endMs: Number(r.end_ms),
  }));
  const tippedAtMs = new Date(tip.tipped_at).getTime();
  if (!Number.isFinite(tippedAtMs)) return;
  const shiftId = matchTipToShift(tippedAtMs, windows);
  if (shiftId != null) {
    await pool.query('UPDATE tips SET shift_id = $1 WHERE id = $2', [shiftId, tipId]);
  }
}

/**
 * Capture missing Stripe fees for the credit-card tips matched to a proposal's
 * shifts, storing each on tips.fee_cents. Run at accrual time, by which point
 * the charges have settled. Best-effort per tip.
 */
async function captureTipFeesForProposal(proposalId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.stripe_payment_intent_id
     FROM tips t JOIN shifts s ON s.id = t.shift_id
     WHERE s.proposal_id = $1 AND t.fee_cents IS NULL`,
    [proposalId]
  );
  for (const row of rows) {
    try {
      const fee = await stripeFeeFor(row.stripe_payment_intent_id);
      if (fee != null) {
        await pool.query('UPDATE tips SET fee_cents = $1 WHERE id = $2', [fee, row.id]);
      }
    } catch (err) {
      Sentry.captureException(err, { tags: { step: 'tip_fee_capture' } });
    }
  }
}

/**
 * Capture missing Stripe fees for a proposal's card payments, storing each on
 * proposal_payments.fee_cents. Payments with no Stripe payment intent (cash,
 * check) are skipped and correctly carry no fee. Best-effort per payment.
 */
async function captureProposalPaymentFees(proposalId) {
  const { rows } = await pool.query(
    `SELECT id, stripe_payment_intent_id FROM proposal_payments
     WHERE proposal_id = $1 AND fee_cents IS NULL
       AND stripe_payment_intent_id IS NOT NULL`,
    [proposalId]
  );
  for (const row of rows) {
    try {
      const fee = await stripeFeeFor(row.stripe_payment_intent_id);
      if (fee != null) {
        await pool.query(
          'UPDATE proposal_payments SET fee_cents = $1 WHERE id = $2',
          [fee, row.id]
        );
      }
    } catch (err) {
      Sentry.captureException(err, { tags: { step: 'proposal_payment_fee_capture' } });
    }
  }
}

module.exports = {
  matchTipToEvent, captureTipFeesForProposal, captureProposalPaymentFees,
};
```

Note: `getStripe()` is the central Stripe client factory (`server/utils/stripeClient.js`), already used by `balanceScheduler.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/payrollTips.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/payrollTips.js server/utils/payrollTips.test.js
git commit -m "feat(payroll): tip and payment fee capture, event matching"
```

---

## Task 10: payrollAccrual.js — accrue payouts for a completed event

**Files:**
- Create: `server/utils/payrollAccrual.js`
- Test: `server/utils/payrollAccrual.test.js`

`accruePayoutsForProposal(proposalId)` is the orchestrator. It computes one `payout_events` row per contractor who worked the event, attached to that contractor's `payouts` row for the event's pay period. It is transactional (a partial failure rolls back) and idempotent: re-running refreshes the system-owned fields and preserves any portal edits to hours, rate, late, and adjustment.

- [ ] **Step 1: Write the failing test**

Create `server/utils/payrollAccrual.test.js`:

```js
require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { accruePayoutsForProposal } = require('./payrollAccrual');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollAccrual.test.js refuses to run against production');
}

let userId, proposalId, shiftId;

before(async () => {
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('accrue@example.com','x','staff') RETURNING id"
  );
  userId = u.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
     ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
    [userId]
  );
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time,
                            event_duration_hours, total_price, pricing_snapshot)
     VALUES (NULL, CURRENT_DATE, 'completed', 'birthday-party', '6:00 PM', 4, 1000,
             '{"breakdown":[{"label":"Shared Gratuity","amount":100}]}')
     RETURNING id`
  );
  proposalId = p.rows[0].id;
  // The shift deliberately omits event_duration_hours: it is NULL on real
  // production shifts, so accrual must read the duration from the proposal.
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES (CURRENT_DATE, '6:00 PM', 'open', $1) RETURNING id`,
    [proposalId]
  );
  shiftId = s.rows[0].id;
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,'Bartender','approved')",
    [shiftId, userId]
  );
});

afterEach(async () => {
  await pool.query(
    `DELETE FROM payout_events WHERE payout_id IN
       (SELECT id FROM payouts WHERE contractor_id = $1)`,
    [userId]
  );
  await pool.query('DELETE FROM payouts WHERE contractor_id = $1', [userId]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('accruePayoutsForProposal > creates a payout and a payout_event for the bartender', async () => {
  await accruePayoutsForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT pe.wage_cents, pe.gratuity_share_cents, pe.line_total_cents, po.total_cents
     FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
     WHERE po.contractor_id = $1`,
    [userId]
  );
  assert.equal(rows.length, 1);
  // Duration 4h read from the proposal -> 5.5 contracted hours @ $20.00 = $110.00.
  // Gratuity $100 to the one bartender; no card payments, so no fee netted.
  assert.equal(rows[0].wage_cents, 11000);
  assert.equal(rows[0].gratuity_share_cents, 10000);
  assert.equal(rows[0].line_total_cents, 21000);
  assert.equal(rows[0].total_cents, 21000);
});

test('accruePayoutsForProposal > is idempotent: a second call does not duplicate', async () => {
  await accruePayoutsForProposal(proposalId);
  await accruePayoutsForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT count(*) FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
     WHERE po.contractor_id = $1`,
    [userId]
  );
  assert.equal(Number(rows[0].count), 1);
});

test('accruePayoutsForProposal > re-accrual preserves an admin edit to hours', async () => {
  await accruePayoutsForProposal(proposalId);
  // Simulate an admin adjusting hours in the portal.
  await pool.query(
    `UPDATE payout_events SET hours = 9
     WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id = $1)`,
    [userId]
  );
  await accruePayoutsForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT pe.hours, pe.wage_cents FROM payout_events pe
     JOIN payouts po ON po.id = pe.payout_id WHERE po.contractor_id = $1`,
    [userId]
  );
  // The edited hours survive; wage is recomputed from them (9 * $20.00).
  assert.equal(Number(rows[0].hours), 9);
  assert.equal(rows[0].wage_cents, 18000);
});

test('accruePayoutsForProposal > nets the card fee out of the gratuity share', async () => {
  // A card payment carrying a $32.00 (3200c) Stripe fee. The proposal's
  // total_price is $1000, so the $100 gratuity bears 10% of that fee.
  await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, fee_cents, stripe_payment_intent_id)
     VALUES ($1, 'full', 100000, 'succeeded', 3200, 'pi_grat_fee')`,
    [proposalId]
  );
  await accruePayoutsForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT pe.gratuity_share_cents FROM payout_events pe
     JOIN payouts po ON po.id = pe.payout_id WHERE po.contractor_id = $1`,
    [userId]
  );
  // Gratuity 10000c; fee share = 3200 * (10000 / 100000) = 320c; net = 9680c.
  assert.equal(rows[0].gratuity_share_cents, 9680);
});

test('accruePayoutsForProposal > splits gratuity evenly across two bartenders', async () => {
  const u2 = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ('accrue2@example.com','x','staff') RETURNING id"
  );
  const user2 = u2.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
     ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
    [user2]
  );
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1,$2,'Bartender','approved')",
    [shiftId, user2]
  );
  try {
    await accruePayoutsForProposal(proposalId);
    const { rows } = await pool.query(
      `SELECT pe.gratuity_share_cents FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id
       WHERE po.contractor_id IN ($1,$2) ORDER BY po.contractor_id`,
      [userId, user2]
    );
    // $100 gratuity split two ways: 5000c each, summing to the full 10000c.
    assert.equal(rows.length, 2);
    assert.equal(rows[0].gratuity_share_cents + rows[1].gratuity_share_cents, 10000);
    assert.equal(rows[0].gratuity_share_cents, 5000);
  } finally {
    await pool.query(
      `DELETE FROM payout_events WHERE payout_id IN
         (SELECT id FROM payouts WHERE contractor_id = $1)`,
      [user2]
    );
    await pool.query('DELETE FROM payouts WHERE contractor_id = $1', [user2]);
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [user2]);
    await pool.query('DELETE FROM users WHERE id = $1', [user2]);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/payrollAccrual.test.js`
Expected: FAIL, `accruePayoutsForProposal is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `server/utils/payrollAccrual.js`:

```js
/**
 * Accrue payout records for a completed event. Idempotent: re-running
 * recomputes the system-owned money fields rather than duplicating rows,
 * and never clobbers an admin's edits to hours, rate, late, or adjustments.
 */
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { payPeriodForDate, computePayday } = require('./payrollPeriods');
const {
  contractedHours, wageCents, splitEvenly,
  extractGratuityCents, proRataFeeCents,
} = require('./payrollMath');
const { captureProposalPaymentFees, captureTipFeesForProposal } = require('./payrollTips');

// Safe calendar date of a pg DATE value as 'YYYY-MM-DD'. node-postgres parses
// a DATE at local midnight, so .toISOString() drifts the day on positive-offset
// servers; read the local components instead. Mirrors toCalendarYmd in
// preEventScheduling.js.
function toCalendarYmd(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/**
 * Ensure the pay_periods row for an event date exists; return { id, status }.
 * Runs on the caller's transaction client. `end_date` and `payday` are pure
 * functions of `start_date`, so the ON CONFLICT update is a no-op write whose
 * only job is to make RETURNING fire for an already-existing row.
 */
async function ensurePayPeriod(client, eventDate) {
  const { startDate, endDate } = payPeriodForDate(eventDate);
  const payday = computePayday(endDate);
  const { rows } = await client.query(
    `INSERT INTO pay_periods (start_date, end_date, payday)
     VALUES ($1, $2, $3)
     ON CONFLICT (start_date) DO UPDATE SET
       end_date = EXCLUDED.end_date,
       payday = EXCLUDED.payday
     RETURNING id, status`,
    [startDate, endDate, payday]
  );
  return rows[0];
}

/**
 * Compute and upsert payout_events (and their parent payouts) for every
 * contractor who worked the given proposal's event. Safe to call repeatedly.
 */
async function accruePayoutsForProposal(proposalId) {
  const propRes = await pool.query(
    `SELECT id, event_date, status, event_duration_hours, total_price, pricing_snapshot
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const proposal = propRes.rows[0];
  if (!proposal || !proposal.event_date) return;
  // Accrual is for completed events only, so it is a safe no-op when called
  // before the event has run (e.g. defensively from elsewhere).
  if (proposal.status !== 'completed') return;
  const eventDate = toCalendarYmd(proposal.event_date);

  // Capture any missing Stripe fees BEFORE opening the transaction: these are
  // network calls and must not hold a DB transaction open. Best-effort — if
  // Stripe is unreachable, accrue with the fees already on record and let a
  // later re-accrual backfill. A Stripe outage must never block payroll.
  try {
    await captureProposalPaymentFees(proposalId);
    await captureTipFeesForProposal(proposalId);
  } catch (err) {
    Sentry.captureException(err);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const payPeriod = await ensurePayPeriod(client, eventDate);
    // Never write into a frozen period. Once Phase 2 introduces processing/paid
    // periods, a late accrual into a closed period would corrupt settled
    // payroll; rolling it into the open period is a Phase 2 concern.
    if (payPeriod.status !== 'open') {
      await client.query('COMMIT');
      return;
    }
    const payPeriodId = payPeriod.id;

    // Everyone who worked this event, with their shift, position, and rate.
    // ORDER BY user_id makes the even-split remainder distribution deterministic.
    const workers = await client.query(
      `SELECT sr.user_id, sr.position, s.id AS shift_id,
              COALESCE(cp.hourly_rate, 20.00) AS hourly_rate
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
       WHERE s.proposal_id = $1 AND sr.status = 'approved'
       ORDER BY sr.user_id`,
      [proposalId]
    );
    if (!workers.rows.length) {
      await client.query('COMMIT');
      return;
    }

    // Bartenders share gratuity and card tips; barbacks/servers do not.
    // Case-insensitive: production seeds the position as 'Bartender'.
    const bartenders = workers.rows.filter(
      w => (w.position || '').toLowerCase() === 'bartender'
    );

    // Gratuity pool, net of the card fee. Per spec section 4.2 the fee
    // denominator is the proposal's full contracted price (proposals.total_price),
    // of which the gratuity is always a part — so the ratio cannot exceed 1.
    const grossGratuity = extractGratuityCents(proposal.pricing_snapshot);
    const proposalTotalCents = Math.round(Number(proposal.total_price || 0) * 100);
    const feeRes = await client.query(
      `SELECT COALESCE(SUM(fee_cents), 0) AS fee
       FROM proposal_payments WHERE proposal_id = $1 AND status = 'succeeded'`,
      [proposalId]
    );
    const gratuityFee = proRataFeeCents(
      grossGratuity, proposalTotalCents, Number(feeRes.rows[0].fee)
    );
    const netGratuity = Math.max(0, grossGratuity - gratuityFee);

    // Card-tip pools (gross and fee) from tips matched to this event's shifts.
    const tipRes = await client.query(
      `SELECT COALESCE(SUM(t.amount_cents), 0) AS gross,
              COALESCE(SUM(t.fee_cents), 0) AS fee
       FROM tips t JOIN shifts s ON s.id = t.shift_id
       WHERE s.proposal_id = $1`,
      [proposalId]
    );
    const tipGross = Number(tipRes.rows[0].gross);
    const tipFee = Number(tipRes.rows[0].fee);

    const n = bartenders.length;
    const gratuityShares = splitEvenly(netGratuity, n);
    const tipGrossShares = splitEvenly(tipGross, n);
    const tipFeeShares = splitEvenly(tipFee, n);
    const bartenderShare = {};
    bartenders.forEach((b, i) => {
      bartenderShare[b.user_id] = {
        gratuity: gratuityShares[i],
        tipGross: tipGrossShares[i],
        tipFee: tipFeeShares[i],
      };
    });

    // Existing line items for this event, keyed by contractor+shift, so a
    // re-accrual preserves admin edits (hours, rate, late, adjustment) and
    // recomputes only the system-owned money fields.
    const existingRes = await client.query(
      `SELECT pe.*, po.contractor_id
       FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id
       JOIN shifts s ON s.id = pe.shift_id
       WHERE s.proposal_id = $1`,
      [proposalId]
    );
    const existing = new Map(
      existingRes.rows.map(r => [`${r.contractor_id}:${r.shift_id}`, r])
    );

    const touchedPayoutIds = new Set();

    for (const w of workers.rows) {
      const prior = existing.get(`${w.user_id}:${w.shift_id}`);
      // First accrual seeds contracted_hours/hours/rate from the contract;
      // afterwards the admin owns them, so re-accrual preserves the prior row.
      const contractedHrs = prior
        ? Number(prior.contracted_hours)
        : contractedHours(Number(proposal.event_duration_hours) || 0);
      const hours = prior ? Number(prior.hours) : contractedHrs;
      const rateCents = prior
        ? Number(prior.rate_cents)
        : Math.round(Number(w.hourly_rate) * 100);
      const late = prior ? prior.late : false;
      const adjustment = prior ? Number(prior.adjustment_cents) : 0;
      const adjustmentNote = prior ? prior.adjustment_note : null;

      // All money is computed here, in JS, and written identically on INSERT
      // and on UPDATE — the two paths can never disagree.
      const wage = wageCents(hours, rateCents);
      const share = bartenderShare[w.user_id] || { gratuity: 0, tipGross: 0, tipFee: 0 };
      const tipNet = share.tipGross - share.tipFee;
      const lineTotal = Math.max(0, wage + share.gratuity + tipNet + adjustment);

      // Upsert the contractor's payout for this period.
      const payoutRes = await client.query(
        `INSERT INTO payouts (pay_period_id, contractor_id)
         VALUES ($1, $2)
         ON CONFLICT (pay_period_id, contractor_id) DO UPDATE
           SET pay_period_id = EXCLUDED.pay_period_id
         RETURNING id`,
        [payPeriodId, w.user_id]
      );
      const payoutId = payoutRes.rows[0].id;
      touchedPayoutIds.add(payoutId);

      // Upsert the payout_event line. Every column is set from EXCLUDED, so the
      // recompute uses the same JS-computed values as the insert.
      await client.query(
        `INSERT INTO payout_events
           (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
            late, gratuity_share_cents, card_tip_gross_cents, card_tip_fee_cents,
            card_tip_net_cents, adjustment_cents, adjustment_note, line_total_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (payout_id, shift_id) DO UPDATE SET
           contracted_hours = EXCLUDED.contracted_hours,
           hours = EXCLUDED.hours,
           rate_cents = EXCLUDED.rate_cents,
           wage_cents = EXCLUDED.wage_cents,
           late = EXCLUDED.late,
           gratuity_share_cents = EXCLUDED.gratuity_share_cents,
           card_tip_gross_cents = EXCLUDED.card_tip_gross_cents,
           card_tip_fee_cents = EXCLUDED.card_tip_fee_cents,
           card_tip_net_cents = EXCLUDED.card_tip_net_cents,
           adjustment_cents = EXCLUDED.adjustment_cents,
           adjustment_note = EXCLUDED.adjustment_note,
           line_total_cents = EXCLUDED.line_total_cents`,
        [payoutId, w.shift_id, contractedHrs, hours, rateCents, wage,
         late, share.gratuity, share.tipGross, share.tipFee,
         tipNet, adjustment, adjustmentNote, lineTotal]
      );
    }

    // Recompute every touched payout's total from its line items.
    await client.query(
      `UPDATE payouts po SET total_cents = COALESCE((
         SELECT SUM(line_total_cents) FROM payout_events WHERE payout_id = po.id
       ), 0)
       WHERE po.id = ANY($1)`,
      [Array.from(touchedPayoutIds)]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { accruePayoutsForProposal, ensurePayPeriod };
```

Note on the upsert: the accrual reads any existing `payout_events` row first (the `existing` Map) and, when one is found, carries forward the admin-editable fields — `contracted_hours`, `hours`, `rate_cents`, `late`, `adjustment_cents`, `adjustment_note` — so a portal edit survives a recompute. `wage_cents` is then re-derived in JS from the carried-forward `hours`/`rate`, and `line_total_cents` from that wage plus the freshly split gratuity/tip shares plus the carried-forward adjustment. Every column in the `ON CONFLICT` clause is set from `EXCLUDED`, so the recompute path writes the exact JS-computed values the insert path would — there is no SQL-side arithmetic that could drift from the JS. The whole pass runs inside one `BEGIN`/`COMMIT`; the Stripe fee captures run before it, since they are network calls that must not hold a transaction open.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/payrollAccrual.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/payrollAccrual.js server/utils/payrollAccrual.test.js
git commit -m "feat(payroll): accrue payouts for a completed event"
```

---

## Task 11: Hook accrual into event auto-completion

**Files:**
- Modify: `server/utils/balanceScheduler.js` (the per-row loop in `processEventCompletions`, around lines 200-221)

- [ ] **Step 1: Add the accrual call**

In `server/utils/balanceScheduler.js`, add the import near the other requires at the top:

```js
const { accruePayoutsForProposal } = require('./payrollAccrual');
```

Inside `processEventCompletions`, in the `for (const proposal of result.rows)` loop, after the existing best-effort side-effects (the activity-log insert and the marketing-handler calls), add a new isolated block:

```js
    // Accrue payroll for the completed event. Best-effort and isolated: a
    // failure here must not abort the completion batch.
    try {
      await accruePayoutsForProposal(proposal.id);
    } catch (err) {
      console.error(`[BalanceScheduler] payout accrual failed for proposal ${proposal.id}:`, err.message);
      Sentry.captureException(err, { tags: { scheduler: 'autocomplete', step: 'payout_accrual' } });
    }
```

This matches the existing best-effort convention in that loop: own `try/catch`, `[BalanceScheduler]` log prefix, `Sentry.captureException`, no rethrow.

- [ ] **Step 2: Verify the module loads**

Run: `node -e "require('dotenv').config(); require('./server/utils/balanceScheduler'); console.log('loads ok')"`
Expected: prints `loads ok` (no import or syntax error).

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the payroll suites.

- [ ] **Step 4: Commit**

```bash
git add server/utils/balanceScheduler.js
git commit -m "feat(payroll): accrue payouts when an event auto-completes"
```

---

## Task 12: Match the tip to its event in the Stripe webhook

**Files:**
- Modify: `server/routes/stripe.js` (the tip branch of the `checkout.session.completed` handler, around lines 1549-1563)

- [ ] **Step 1: Match the tip after the insert**

In `server/routes/stripe.js`, the tip webhook branch inserts the `tips` row with `ON CONFLICT (stripe_payment_intent_id) DO NOTHING`, then `return res.json({ received: true })`. Change that insert to return the row id, and match the tip to its event before responding. Fee capture is deliberately NOT done in the webhook: at `checkout.session.completed` the Stripe charge has usually not settled, so the balance-transaction fee is not yet available. Tip fees are captured later, at accrual time, by `captureTipFeesForProposal`.

Add the import near the top of `server/routes/stripe.js` with the other requires:

```js
const { matchTipToEvent } = require('../utils/payrollTips');
```

Replace the tip insert and its `return` with:

```js
      const inserted = await pool.query(`
        INSERT INTO tips (tip_page_token, target_user_id, amount_cents,
                          stripe_payment_intent_id, stripe_session_id,
                          customer_email, tipped_at)
        VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))
        ON CONFLICT (stripe_payment_intent_id) DO NOTHING
        RETURNING id
      `, [
        token, dbUserId, session.amount_total, piId, session.id,
        session.customer_details && session.customer_details.email
          ? session.customer_details.email : null,
        session.created,
      ]);

      // Best-effort: match the tip to its event. Must not fail the webhook.
      if (inserted.rows.length) {
        try {
          await matchTipToEvent(inserted.rows[0].id);
        } catch (err) {
          Sentry.captureException(err, { tags: { webhook: 'tip', step: 'tip_match' } });
        }
      }
      return res.json({ received: true });
```

`inserted.rows.length` is 0 when the `ON CONFLICT` skipped a duplicate, so matching runs only on a genuinely new tip. `matchTipToEvent` is pure DB with no Stripe call, so it does not risk the webhook's response budget.

- [ ] **Step 2: Verify the module loads**

Run: `node -e "require('dotenv').config(); require('./server/routes/stripe'); console.log('loads ok')"`
Expected: prints `loads ok`.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add server/routes/stripe.js
git commit -m "feat(payroll): match the tip to its event on the tip webhook"
```

---

## Task 13: Hook accrual into the manual completion path

**Files:**
- Modify: `server/routes/proposals/lifecycle.js` (the `PATCH /:id/status` handler)

- [ ] **Step 1: Find the existing completion block**

Open `server/routes/proposals/lifecycle.js`. `PATCH /:id/status` already has a post-commit block, guarded by `if (status === 'completed')` (around lines 165-176), that fires the marketing handlers (`scheduleReviewRequest`, `scheduleRetentionNudge`). The accrual call belongs inside that existing block, not in a new one. Confirm the block is there before continuing.

- [ ] **Step 2: Add the accrual call to that block**

Add the import near the other requires at the top of `lifecycle.js`:

```js
const { accruePayoutsForProposal } = require('../../utils/payrollAccrual');
```

Inside the existing `if (status === 'completed')` post-commit block, alongside the marketing-handler calls, add a best-effort accrual call:

```js
      try {
        await accruePayoutsForProposal(Number(req.params.id));
      } catch (err) {
        Sentry.captureException(err, { tags: { route: 'proposal_status', step: 'payout_accrual' } });
      }
```

Match the block's existing variable names (it uses `status` and `req.params.id`, not `newStatus` / `proposalId`). `accruePayoutsForProposal` is idempotent and guards on the proposal being `completed`, so it is safe even if the event later also runs through `processEventCompletions`.

- [ ] **Step 3: Verify the module loads**

Run: `node -e "require('dotenv').config(); require('./server/routes/proposals/lifecycle'); console.log('loads ok')"`
Expected: prints `loads ok`.

- [ ] **Step 4: Run the full test suite and commit**

Run: `npm test`
Expected: all tests pass.

```bash
git add server/routes/proposals/lifecycle.js
git commit -m "feat(payroll): accrue payouts on manual event completion"
```

---

## Phase 1 done

At the end of Phase 1 the backend has: the payroll ledger schema, a fully unit-tested pure computation engine (periods, payday, wage, splits, gratuity, fee math, tip matching), and DB modules that accrue payout records whenever an event completes, automatically or manually. Card tips get their fee captured and their event matched as they arrive.

A tip matched to an event after that event already accrued (a late-night tip arriving after the hourly auto-complete ran) is recorded against its shift but is not yet reflected in the payout. Recomputing an open payout when a late tip lands is part of the portal's live-recompute behavior, covered in Phase 2; no payout is frozen in Phase 1, so nothing is lost in the meantime.

Nothing is user-visible yet. Phase 2 (the admin payroll portal) is the next plan.
