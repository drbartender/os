---
lanes:
  - id: invoice-derivation
    footprint:
      - server/utils/proposalMoneyShared.js
      - server/utils/invoiceLifecycle.js
      - server/utils/invoiceLifecycle.derivation.test.js
      - server/utils/invoiceLifecycle.external.test.js
      - server/utils/lineItemCancel.js
      - server/scripts/remediateInvoiceDerivation.js
      - scripts/money-smoke-list.txt
      - README.md
      - ARCHITECTURE.md
    # FOOTPRINT AMENDED mid-build, approved by Dallas 2026-07-28:
    #  + lineItemCancel.js — the new derivation voids a delta invoice before
    #    reconcileOpenDeltaInvoices queries for it, so the admin cancel
    #    preview's delta_invoices_adjusted went silently empty. The report is
    #    now a before/after diff across the whole cascade.
    #  + invoiceLifecycle.external.test.js — its fixture seeded an open Balance
    #    AND Full Payment on one proposal, the two-remainder shape the
    #    derivation now refuses. Split to one proposal per label.
    #  - refundHelpers.js — DROPPED. The plan claimed
    #    TOTAL_TRACKING_INVOICE_LABELS had to widen in lockstep. That was
    #    backwards; refundHelpers.scope.test.js RC1 caught it. See the
    #    constant's comment in proposalMoneyShared.js.
    deps: []
    review: full-fleet
  - id: overbill-monitor
    footprint:
      - server/utils/balanceInvoiceMonitor.js
      - server/utils/balanceInvoiceMonitor.test.js
      - server/index.js
      - .env.example
      - .claude/CLAUDE.md
      - README.md
      - ARCHITECTURE.md
    deps: [invoice-derivation]
    review: full-fleet
  - id: invoice-void-ui
    footprint:
      - client/src/pages/admin/ProposalDetailPaymentPanel.js
    deps: []
    review: light
---

# Invoice Derivation and Over-Billing Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every open invoice a correct derived view of its proposal, so a re-price can never leave a client billed more than they owe, and alarm when one is.

**Architecture:** `refreshUnlockedInvoices` currently derives a Balance from `total_price − external_paid − Σ(locked invoice amount_due)`, using locked invoices as a proxy for money already collected, and skips any label outside `Deposit`/`Balance`/`Full Payment` entirely. Both are wrong and each produced live over-billings. This plan replaces the proxy with `amount_paid`, splits invoices into partial bills (capped) and remainder bills (derived), widens `TOTAL_TRACKING_INVOICE_LABELS` in lockstep so refund reconciliation cannot double-correct, then adds a read-only hourly monitor on the resulting invariant.

**Tech Stack:** Node/Express, raw SQL via `pg`, `node:test` against the shared dev DB, React admin client, Sentry, Resend via `notifyAdminCategory`.

## Global Constraints

- Money is integer cents everywhere in invoice code. `proposals.total_price` / `amount_paid` / `deposit_amount` are DOLLARS (`numeric`) and must go through `toCents()` from `invoiceShared`. `invoices.amount_due` / `amount_paid` are CENTS.
- **The invariant:** `Σ(open invoice remaining) ≤ owed`, where `owed = total_price − amount_paid`. Never equality.
- `amount_paid` already contains `external_paid`. Never subtract `external_paid` separately from a basis that also subtracts `amount_paid`.
- Locked invoices are receipts. No task in this plan writes to a row with `locked = true`.
- Server tests share the dev DB. Run **one suite at a time** via `node -r dotenv/config --test <file>`. Every suite creates its own synthetic client/proposal and deletes it in `finally`.
- No em dashes in any client-visible copy or admin email body.
- The monitor is **alert-only**. It reads `proposals`/`invoices` and writes only `proposal_activity_log`. It never creates, edits, or voids an invoice.

---

## Lane 1: `invoice-derivation`

### Task 1: Split invoice labels into partial bills and remainder bills

**Files:**
- Modify: `server/utils/proposalMoneyShared.js:40-63`
- Modify: `server/utils/refundHelpers.js:15-19,346-347`

**Interfaces:**
- Produces: `PARTIAL_BILL_LABELS` (frozen `string[]`), `isTotalTracking(label: string) => boolean`. Task 2 consumes both. `TOTAL_TRACKING_INVOICE_LABELS` is **removed**; `refundHelpers` switches to `isTotalTracking`.

Read the existing comment block at `proposalMoneyShared.js:40-55` before editing. It states that `TOTAL_TRACKING_INVOICE_LABELS` exists precisely so that "adding a label to the refresh can never silently desync this rule". Task 2 adds every label to the refresh, so this constant must change in the same lane or `applyRefundReconciliation` will drop an invoice's `amount_due` itself *and* let the refresh drop it again.

- [ ] **Step 1: Write the failing test**

Create `server/utils/invoiceLifecycle.derivation.test.js` with only this test for now:

```js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { PARTIAL_BILL_LABELS, isTotalTracking } = require('./proposalMoneyShared');

test('partial-bill labels are exactly Deposit and Drink Plan Extras', () => {
  assert.deepEqual([...PARTIAL_BILL_LABELS].sort(), ['Deposit', 'Drink Plan Extras']);
});

test('isTotalTracking is true for every remainder label, false for partial bills', () => {
  for (const label of ['Balance', 'Full Payment', 'Additional Services', 'Gratuity Balance', 'Some Manual Label']) {
    assert.equal(isTotalTracking(label), true, `${label} must be refresh-managed`);
  }
  for (const label of ['Deposit', 'Drink Plan Extras']) {
    assert.equal(isTotalTracking(label), false, `${label} is a capped partial, not total-tracking`);
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node -r dotenv/config --test server/utils/invoiceLifecycle.derivation.test.js`
Expected: FAIL, `PARTIAL_BILL_LABELS` is `undefined` so `[...undefined]` throws.

- [ ] **Step 3: Replace the constant in `proposalMoneyShared.js`**

Delete `TOTAL_TRACKING_INVOICE_LABELS` (lines 40-55, comment included) and add:

```js
// Labels that deliberately bill a SUBSET of what the proposal owes.
// refreshUnlockedInvoices never RAISES one of these; it only CAPS it at what
// is still owed, so a partial bill can never become an over-bill.
//   'Deposit'           — intended amount is proposals.deposit_amount.
//   'Drink Plan Extras' — intended amount is its own amount_due, owned by
//                         findOrRefreshExtrasInvoice (invoiceExtras.js). The
//                         cap is the ONLY safe interaction between the two
//                         writers: it can reduce an over-bill but can never
//                         contradict the extras owner's figure.
const PARTIAL_BILL_LABELS = Object.freeze(['Deposit', 'Drink Plan Extras']);

// Is this invoice's DEMAND managed by refreshUnlockedInvoices? Every label
// except a partial bill is, because the refresh assigns remainder labels
// `owed - Σ(open partials)` on every reprice AND every refund (a refund lowers
// amount_paid, which raises owed, which raises the remainder invoice).
//
// This replaces TOTAL_TRACKING_INVOICE_LABELS, which was an allow-list of
// ['Balance','Full Payment'] back when the refresh skipped every other label.
// It is a predicate now, not a list, because manual labels are open-ended and
// an allow-list cannot enumerate them.
//
// Consumed by refundHelpers.applyRefundReconciliation to decide whether IT
// must drop an invoice's amount_due or whether the refresh will. Getting this
// wrong double-drops the demand and strands a client-visible phantom balance
// on a live pay link (push review, 2026-07-26).
function isTotalTracking(label) {
  return !PARTIAL_BILL_LABELS.includes(label);
}
```

Update `module.exports` to export `PARTIAL_BILL_LABELS` and `isTotalTracking` in place of `TOTAL_TRACKING_INVOICE_LABELS`.

- [ ] **Step 4: Repoint `refundHelpers.js`**

At line 15-19, change the import:

```js
const {
  CONTRACT_LABELS,
  OFF_LEDGER_INVOICE_LABELS,
  isTotalTracking,
} = require('./proposalMoneyShared');
```

At line 346-347, change the predicate:

```js
      const demandIsRefreshManaged = link.invoice_locked !== true
        && isTotalTracking(link.invoice_label);
```

- [ ] **Step 5: Run the test plus every refund suite**

```bash
node -r dotenv/config --test server/utils/invoiceLifecycle.derivation.test.js
node -r dotenv/config --test server/utils/refundHelpers.scope.test.js
node -r dotenv/config --test server/routes/invoices.refunds.test.js
```

Expected: all PASS. Run them one at a time, not in one command with `&&` chaining that could interleave against the shared dev DB.

- [ ] **Step 6: Commit**

```bash
git add server/utils/proposalMoneyShared.js server/utils/refundHelpers.js server/utils/invoiceLifecycle.derivation.test.js
git commit -m "refactor(money): partial-bill vs remainder label split, isTotalTracking predicate"
```

---

### Task 2: Rewrite the derivation in `refreshUnlockedInvoices`

**Files:**
- Modify: `server/utils/invoiceLifecycle.js:78-164`
- Test: `server/utils/invoiceLifecycle.derivation.test.js`

**Interfaces:**
- Consumes: `PARTIAL_BILL_LABELS`, `isTotalTracking` from Task 1.
- Produces: `refreshUnlockedInvoices(proposalId, dbClient)` keeps its exact signature and `Promise<void>` return. All four production callers (`server/routes/proposals/crud.js:712`, `server/routes/drinkPlans/submit.js:526`, `server/routes/drinkPlans/lab.js:408`, `server/utils/lineItemCancel.js:608`) are unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `server/utils/invoiceLifecycle.derivation.test.js`. This helper goes first:

```js
const { pool } = require('../db');
const { refreshUnlockedInvoices } = require('./invoiceLifecycle');

let seq = 0;
async function fixture({ total, paid, deposit = 100, invoices }) {
  if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');
  const tag = `${process.pid}-${++seq}`;
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ('Derivation Fixture', $1, 'other') RETURNING id`,
    [`derivation-${tag}@example.com`]
  );
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, guest_count, total_price, amount_paid, deposit_amount, status)
     VALUES ($1, '2026-12-01', 50, $2, $3, $4, 'deposit_paid') RETURNING id`,
    [c.rows[0].id, total, paid, deposit]
  );
  const made = [];
  for (const inv of invoices) {
    const r = await pool.query(
      `INSERT INTO invoices (proposal_id, label, amount_due, amount_paid, status, locked, invoice_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [p.rows[0].id, inv.label, inv.due, inv.paid || 0, inv.status || 'sent',
       inv.locked || false, `DV${tag}${made.length}`]
    );
    made.push({ ...inv, id: r.rows[0].id });
  }
  return { clientId: c.rows[0].id, proposalId: p.rows[0].id, invoices: made };
}

async function cleanup(f) {
  await pool.query('DELETE FROM invoice_line_items WHERE invoice_id = ANY($1)', [f.invoices.map((i) => i.id)]);
  await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [f.proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [f.proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [f.clientId]);
}

async function amountOf(id) {
  const { rows: [row] } = await pool.query('SELECT amount_due, status FROM invoices WHERE id = $1', [id]);
  return { due: Number(row.amount_due), status: row.status };
}
```

Then the eight behavior tests:

```js
// Mechanism A: a paid deposit with NO Deposit invoice backing it (the David
// Luebke shape). The old locked-invoice-sum proxy read $0 collected and
// re-billed the full total.
test('Balance derives from amount_paid when no locked invoice backs the payment', async () => {
  const f = await fixture({ total: 1100, paid: 100, invoices: [{ label: 'Balance', due: 110000 }] });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 100000);
  } finally { await cleanup(f); }
});

// external_paid lives INSIDE amount_paid; subtracting it again double-counts.
test('external_paid is not subtracted twice', async () => {
  const f = await fixture({ total: 930, paid: 100, invoices: [{ label: 'Balance', due: 1 }] });
  try {
    await pool.query('UPDATE proposals SET external_paid = 100 WHERE id = $1', [f.proposalId]);
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 83000);
  } finally { await cleanup(f); }
});

// Mechanism B: the bespoke label the old code `continue`d past (Brandon Martin).
test('a bespoke remainder label re-derives on a price decrease', async () => {
  const f = await fixture({ total: 420, paid: 350, invoices: [{ label: 'Additional Services', due: 15000 }] });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 7000);
  } finally { await cleanup(f); }
});

// Cathy Murphy: fully paid, stranded Additional Services invoice.
test('a remainder invoice deriving to zero is voided, not left open at $0', async () => {
  const f = await fixture({ total: 1192.5, paid: 1192.5, invoices: [{ label: 'Additional Services', due: 18500 }] });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.deepEqual(await amountOf(f.invoices[0].id), { due: 0, status: 'void' });
  } finally { await cleanup(f); }
});

// The 154-row case. A deposit is a deliberate partial bill.
test('an open Deposit keeps deposit_amount and is never raised to owed', async () => {
  const f = await fixture({ total: 1000, paid: 0, deposit: 100, invoices: [{ label: 'Deposit', due: 10000 }] });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 10000);
  } finally { await cleanup(f); }
});

test('an open Deposit is capped when it exceeds what is still owed', async () => {
  const f = await fixture({ total: 100, paid: 60, deposit: 100, invoices: [{ label: 'Deposit', due: 10000 }] });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 4000);
  } finally { await cleanup(f); }
});

// Eve Thornton. The extras invoice is capped, never raised.
test('Drink Plan Extras is capped at owed and a sharing remainder gets the rest', async () => {
  const f = await fixture({
    total: 500, paid: 100,
    invoices: [{ label: 'Drink Plan Extras', due: 15500 }, { label: 'Balance', due: 50000 }],
  });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 15500, 'extras keeps its own figure when it fits');
    assert.equal((await amountOf(f.invoices[1].id)).due, 24500, 'remainder = 40000 owed - 15500 extras');
  } finally { await cleanup(f); }
});

test('locked invoices are never modified', async () => {
  const f = await fixture({
    total: 420, paid: 350,
    invoices: [{ label: 'Balance', due: 25000, paid: 25000, status: 'paid', locked: true }],
  });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.deepEqual(await amountOf(f.invoices[0].id), { due: 25000, status: 'paid' });
  } finally { await cleanup(f); }
});

test('two remainder invoices: nothing is written', async () => {
  const f = await fixture({
    total: 500, paid: 0,
    invoices: [{ label: 'Additional Services', due: 10000 }, { label: 'Gratuity Balance', due: 20000 }],
  });
  try {
    await refreshUnlockedInvoices(f.proposalId);
    assert.equal((await amountOf(f.invoices[0].id)).due, 10000, 'refuses to guess an allocation');
    assert.equal((await amountOf(f.invoices[1].id)).due, 20000);
  } finally { await cleanup(f); }
});
```

Add `await pool.end();` in a final `test.after(...)` hook rather than inside each test, since there are now many tests in one file:

```js
test.after(async () => { await pool.end(); });
```

- [ ] **Step 2: Run to confirm they fail**

Run: `node -r dotenv/config --test server/utils/invoiceLifecycle.derivation.test.js`
Expected: the two Task 1 tests PASS; the nine new ones FAIL (the old code returns 110000 for the first, skips the bespoke labels, and so on).

- [ ] **Step 3: Replace the body of `refreshUnlockedInvoices`**

Replace `invoiceLifecycle.js:78-164` entirely. Update the imports at the top of the file to add `Sentry` and the new constants:

```js
const Sentry = require('@sentry/node');
const { CONTRACT_LABELS, PARTIAL_BILL_LABELS } = require('./proposalMoneyShared');
```

(Drop the now-unused `OFF_LEDGER_INVOICE_LABELS` import from this file; it was only referenced by the locked-total query being deleted. Confirm with `grep -n OFF_LEDGER_INVOICE_LABELS server/utils/invoiceLifecycle.js` after editing that zero references remain.)

```js
/**
 * Re-derive amount_due (and line items) for every unlocked, non-void invoice
 * on a proposal, so the open invoices are always a correct view of what the
 * client still owes.
 *
 * THE INVARIANT: Σ(open invoice amount_due) ≤ owed, where
 * owed = total_price − amount_paid. Not equality: a partial bill is a
 * deliberate under-bill. Over-billing is never correct.
 *
 * owed uses amount_paid, NOT the old `Σ(locked invoice amount_due)` proxy.
 * That proxy assumed every payment is backed by a locked invoice, which
 * nothing enforces: prop 51 took a $100 Stripe deposit in 2026-05 and has no
 * Deposit invoice at all, so the proxy read $0 collected and every re-price
 * re-billed the deposit (2026-07-28). external_paid is deliberately absent
 * from the expression because amount_paid already contains it; subtracting it
 * again is the same double-count in the other direction.
 *
 * Partial bills (PARTIAL_BILL_LABELS) are CAPPED, never raised — see that
 * constant for why 'Drink Plan Extras' must not be raised here. Every other
 * label is a remainder bill and takes owed minus the open partials.
 *
 * @param {number} proposalId
 * @param {object} [dbClient]
 */
async function refreshUnlockedInvoices(proposalId, dbClient) {
  const client = db(dbClient);

  const [propResult, unlockedResult] = await Promise.all([
    client.query(
      `SELECT total_price, deposit_amount, amount_paid FROM proposals WHERE id = $1`,
      [proposalId]
    ),
    client.query(
      `SELECT id, label, amount_due FROM invoices
        WHERE proposal_id = $1 AND locked = false AND status != 'void'
        ORDER BY id`,
      [proposalId]
    ),
  ]);

  if (propResult.rows.length === 0) return;

  const prop = propResult.rows[0];
  const owed = Math.max(0, toCents(prop.total_price) - toCents(prop.amount_paid));
  const depositCents = toCents(prop.deposit_amount);

  const rows = unlockedResult.rows;
  const partials = rows.filter((r) => PARTIAL_BILL_LABELS.includes(r.label));
  const remainders = rows.filter((r) => !PARTIAL_BILL_LABELS.includes(r.label));

  // Allocating owed across two remainder bills has no correct answer without
  // knowing which one is meant to carry the balance. Zero such rows exist in
  // prod (verified 2026-07-28), so refuse to guess rather than invent a rule.
  if (remainders.length > 1) {
    console.warn(`[invoice-derivation] proposal ${proposalId} has ${remainders.length} remainder invoices; skipping refresh`);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage(`Multiple remainder invoices on proposal ${proposalId}`, {
        level: 'warning',
        tags: { area: 'invoice_derivation' },
        extra: { proposalId, labels: remainders.map((r) => r.label) },
        fingerprint: ['invoice-derivation-multi-remainder', String(proposalId)],
      });
    }
    return;
  }

  // Cap each partial against what is still unallocated, then hand the rest to
  // the single remainder bill (if any).
  let unallocated = owed;
  const writes = [];
  for (const inv of partials) {
    const intended = inv.label === 'Deposit' ? depositCents : Number(inv.amount_due);
    const amountDue = Math.max(0, Math.min(intended, unallocated));
    unallocated -= amountDue;
    writes.push({ inv, amountDue });
  }
  for (const inv of remainders) {
    writes.push({ inv, amountDue: unallocated });
    unallocated = 0;
  }

  const proposalLineItems = await generateLineItemsFromProposal(proposalId, client);

  for (const { inv, amountDue } of writes) {
    const changed = Number(inv.amount_due) !== amountDue;

    // A zero-due open invoice is not harmless: it can capture the proposal's
    // open_invoice_token and present a $0 "Pay balance" button. Void it.
    // 'Drink Plan Extras' is exempt because voiding one has a comp-reconcile
    // side effect owned by voidExtrasInvoiceWithReconcile (invoiceExtras.js),
    // and reaching into that from here would be a require cycle. Flag it for a
    // human instead; the monitor reports it too.
    if (amountDue === 0 && inv.label !== 'Drink Plan Extras') {
      await client.query(
        `UPDATE invoices SET amount_due = 0, status = 'void', updated_at = NOW() WHERE id = $1`,
        [inv.id]
      );
      continue;
    }

    await client.query(
      `UPDATE invoices SET amount_due = $1, updated_at = NOW() WHERE id = $2`,
      [amountDue, inv.id]
    );

    if (amountDue === 0 && process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage(`Drink Plan Extras invoice ${inv.id} derived to $0 and needs a reconciled void`, {
        level: 'warning',
        tags: { area: 'invoice_derivation' },
        extra: { proposalId, invoiceId: inv.id },
        fingerprint: ['invoice-derivation-zero-extras', String(inv.id)],
      });
    }

    if (CONTRACT_LABELS.includes(inv.label)) {
      // Contract labels show the full contract breakdown against a partial
      // amount_due; that is the established shape (INV-0144 shows a $350
      // package line against a $250 balance) and is unchanged here.
      await writeLineItems(inv.id, proposalLineItems, client);
    } else if (changed) {
      // A bespoke invoice's lines are its own. Collapse to one line so they
      // sum to the new amount instead of dumping a paid-for package breakdown
      // onto it. Only on change, so an untouched extras invoice keeps the
      // itemization writeExtrasLineItems gave it.
      await writeLineItems(
        inv.id,
        [{
          description: inv.label,
          quantity: 1,
          unit_price: amountDue,
          line_total: amountDue,
          source_type: 'manual',
          source_id: null,
        }],
        client
      );
    }
  }
}
```

- [ ] **Step 4: Run the derivation suite**

Run: `node -r dotenv/config --test server/utils/invoiceLifecycle.derivation.test.js`
Expected: all 11 tests PASS.

- [ ] **Step 5: Run every suite this function reaches**

`refreshUnlockedInvoices` has four production callers. Run the suites covering all of them, one at a time:

```bash
node -r dotenv/config --test server/utils/invoiceLifecycle.external.test.js
node -r dotenv/config --test server/utils/invoiceLifecycle.additionalInvoice.test.js
node -r dotenv/config --test server/utils/refundHelpers.scope.test.js
node -r dotenv/config --test server/routes/drinkPlans/submitReconcile.test.js
node -r dotenv/config --test server/routes/drinkPlans/submitOverride.test.js
node -r dotenv/config --test server/utils/lineItemCancel.test.js
node -r dotenv/config --test server/routes/proposals/cancelLineItem.test.js
node -r dotenv/config --test server/routes/invoices.extrasVoid.test.js
node -r dotenv/config --test server/routes/invoices.refunds.test.js
node -r dotenv/config --test server/utils/invoiceVoid.test.js
node -r dotenv/config --test server/routes/proposals/recordPayment.invoiceCap.test.js
```

**`invoiceLifecycle.external.test.js` is expected to need editing, not to pass as written.** It asserts `total 930 − external 100 = 83000` on a fixture with `amount_paid = 100`. Under the new basis the arithmetic reaches the same 83000 through `total − amount_paid`, so the assertion should still hold, but its comment (`"$930 total − $100 external"`) now describes the wrong mechanism. Update the comment to say `total − amount_paid`, and keep the assertion. If any other suite fails, do not weaken the assertion: read what it is protecting and decide deliberately, because these are money suites.

- [ ] **Step 6: Add the suite to the money smoke list**

Append `server/utils/invoiceLifecycle.derivation.test.js` to `scripts/money-smoke-list.txt` so the pre-push money gate runs it.

- [ ] **Step 7: Commit**

```bash
git add server/utils/invoiceLifecycle.js server/utils/invoiceLifecycle.derivation.test.js server/utils/invoiceLifecycle.external.test.js scripts/money-smoke-list.txt
git commit -m "fix(money): derive open invoices from amount_paid, cap partials, stop skipping bespoke labels"
```

---

### Task 3: Remediation script for the four live over-billings

**Files:**
- Create: `server/scripts/remediateInvoiceDerivation.js`
- Modify: `README.md` (folder tree + NPM scripts if one is added)

**Interfaces:**
- Consumes: `refreshUnlockedInvoices` from Task 2, `voidExtrasInvoiceWithReconcile` from `server/utils/invoiceExtras.js`.
- Produces: nothing consumed by later tasks. Terminal.

- [ ] **Step 1: Write the script**

```js
// One-time remediation for the 2026-07-28 over-billing incident. Runs the
// FIXED derivation over the affected proposals, so this doubles as live
// validation of Task 2 on the four cases that motivated it. Idempotent.
//
// Usage:  node -r dotenv/config server/scripts/remediateInvoiceDerivation.js [--apply]
// Without --apply it prints the before/after and writes nothing.
require('dotenv').config();
const { pool } = require('../db');
const { refreshUnlockedInvoices } = require('../utils/invoiceLifecycle');
const { voidExtrasInvoiceWithReconcile } = require('../utils/invoiceExtras');

const PROPOSALS = [51, 557, 491, 556];
const APPLY = process.argv.includes('--apply');

async function snapshot(proposalId) {
  const { rows } = await pool.query(
    `SELECT i.id, i.invoice_number, i.label, i.amount_due, i.status, i.locked,
            p.total_price, p.amount_paid
       FROM invoices i JOIN proposals p ON p.id = i.proposal_id
      WHERE i.proposal_id = $1 ORDER BY i.id`,
    [proposalId]
  );
  return rows;
}

(async () => {
  for (const id of PROPOSALS) {
    const before = await snapshot(id);
    if (before.length === 0) { console.log(`prop ${id}: no invoices, skipped`); continue; }
    console.log(`\nprop ${id}  total=${before[0].total_price} paid=${before[0].amount_paid}`);
    for (const r of before) {
      console.log(`  BEFORE ${r.invoice_number} ${r.label} $${(r.amount_due / 100).toFixed(2)} ${r.status}${r.locked ? ' LOCKED' : ''}`);
    }
    if (!APPLY) continue;

    await refreshUnlockedInvoices(id);

    // The derivation deliberately will not void a Drink Plan Extras invoice
    // (comp-reconcile side effect). Finish those here.
    for (const r of await snapshot(id)) {
      if (r.label === 'Drink Plan Extras' && Number(r.amount_due) === 0
          && r.status !== 'void' && !r.locked) {
        await voidExtrasInvoiceWithReconcile(r.id, null, pool, { reason: 'derivation remediation 2026-07-28' });
      }
    }
    for (const r of await snapshot(id)) {
      console.log(`  AFTER  ${r.invoice_number} ${r.label} $${(r.amount_due / 100).toFixed(2)} ${r.status}`);
    }
  }
  await pool.end();
})().catch((err) => { console.error(err); process.exit(1); });
```

Before writing the `voidExtrasInvoiceWithReconcile` call, read its signature at `server/utils/invoiceExtras.js:307` and match the real parameter shape. The call above assumes `(invoiceId, actorId, dbClient, opts)`; correct it if the source differs.

- [ ] **Step 2: Dry run against the dev DB**

Run: `node -r dotenv/config server/scripts/remediateInvoiceDerivation.js`
Expected: prints BEFORE lines for whatever those proposal ids hold on dev, writes nothing. Dev is not prod, so the amounts will not match the incident; you are checking the script runs clean and the query shape is right.

- [ ] **Step 3: Commit**

```bash
git add server/scripts/remediateInvoiceDerivation.js README.md
git commit -m "chore(money): one-time remediation script for the 2026-07-28 over-billing incident"
```

- [ ] **Step 4: Stop. Prod run is a separate, gated action**

Do NOT run this against prod from inside the lane. It runs after the lane merges and ships, against prod, with Dallas present. Expected prod result:

| Prop | Invoice | Before | After |
|---|---|---|---|
| 51 David Luebke | INV-0016 | $1,000 (hand-corrected 7/28) | $1,000, unchanged |
| 557 Brandon Martin | INV-0199 | $150 | $70 |
| 491 Cathy Murphy | INV-0216 | $185 | voided |
| 556 Eve Thornton | INV-0168 | $155 | voided |

No client email on any of these.

---

## Lane 2: `overbill-monitor`

Depends on Lane 1 merging first, both because its deployment gate is "alerts on nothing after remediation" and because both lanes edit `README.md` / `ARCHITECTURE.md`.

### Task 4: `balanceInvoiceMonitor.js`

**Files:**
- Create: `server/utils/balanceInvoiceMonitor.js`
- Test: `server/utils/balanceInvoiceMonitor.test.js`

**Interfaces:**
- Produces: `monitorMissingBalanceInvoices()` returning `Promise<{ candidates: number, alerted: number, throttled: number }>`. Task 5 wires it into `server/index.js`.

Read `docs/superpowers/specs/2026-07-21-balance-invoice-reconciler-design.md` first. The under-covered detection query in its §Detection is copied **verbatim**; it is tuned money SQL that was verified at zero rows against prod, and it does not get re-derived. This task adds the over-billed direction alongside it.

- [ ] **Step 1: Write the failing tests**

`server/utils/balanceInvoiceMonitor.test.js`, using the same fixture/cleanup helper shape as Task 2's suite (repeat it; do not import across test files). Cases:

```js
// OVER direction, one per live shape from the incident.
test('alerts when a bespoke invoice exceeds what is owed (Brandon shape)', ...)
  // total 420, paid 350, open 'Additional Services' $150 → payable 15000 > owed 7000
test('alerts when an invoice is open against a fully paid proposal (Cathy shape)', ...)
  // total 1192.50, paid 1192.50, open 'Additional Services' $185 → 18500 > 0
test('alerts when a Balance ignores a payment with no locked invoice (David shape)', ...)
  // total 1100, paid 100, open 'Balance' $1100 → 110000 > 100000

// UNDER direction, from the 2026-07-21 spec.
test('alerts when a confirmed proposal has a balance and no payable invoice', ...)
test('alerts when the only Balance invoice is voided', ...)
test('alerts when the only open invoice is zero-due', ...)

// Quiet.
test('quiet when an open invoice exactly carries the balance', ...)
test('quiet when a bespoke-label invoice carries the balance (Iga shape)', ...)
  // total 600, paid 500, open 'Gratuity Balance' $100 → payable == owed
test('quiet at deposit stage: open Deposit under owed on a sent proposal', ...)
test('quiet for archived, balance_paid, completed, clientless, zero-balance, NULL money columns', ...)

// Mechanics.
test('throttle: a second run within 24h sends no second email and counts as throttled', ...)
test('writes one proposal_activity_log row per alert with the balance and invoice labels', ...)
test('returned counts match the rows actually alerted', ...)
```

Write each of these out fully against the fixture helper. Assert on the returned `{ candidates, alerted, throttled }` and on `proposal_activity_log` rows, and stub the email by asserting the marker row rather than by intercepting Resend.

- [ ] **Step 2: Run to confirm they fail**

Run: `node -r dotenv/config --test server/utils/balanceInvoiceMonitor.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the module**

Two queries against the shared shape. The over-billed one:

```sql
SELECT p.id, c.name AS client_name, p.status, p.event_date,
       COALESCE((
         SELECT SUM(i.amount_due - i.amount_paid) FROM invoices i
          WHERE i.proposal_id = p.id
            AND i.status IN ('sent','partially_paid')
            AND i.amount_due > i.amount_paid
       ), 0)
     - (ROUND(COALESCE(p.total_price,0) * 100)::int
      - ROUND(COALESCE(p.amount_paid,0) * 100)::int) AS excess_cents
  FROM proposals p JOIN clients c ON c.id = p.client_id
 WHERE p.status NOT IN ('draft','archived')
   AND COALESCE((
         SELECT SUM(i.amount_due - i.amount_paid) FROM invoices i
          WHERE i.proposal_id = p.id
            AND i.status IN ('sent','partially_paid')
            AND i.amount_due > i.amount_paid
       ), 0)
     > ROUND(COALESCE(p.total_price,0) * 100)::int
     - ROUND(COALESCE(p.amount_paid,0) * 100)::int
 ORDER BY p.id
```

The under-covered one is the spec's §Detection query, unchanged.

Escalation per offending proposal, matching the spec:
- `Sentry.captureMessage`, gated on `process.env.SENTRY_DSN_SERVER`, `level: 'warning'`, `tags: { scheduler: 'balance_invoice_monitor' }`, `fingerprint: ['balance-invoice-monitor', direction, String(id)]`. Message for OVER: `Client over-billed: open invoices exceed balance due (proposal <id>)`. For UNDER, the spec's existing message.
- One `proposal_activity_log` row, `actor_type: 'system'`, `action: 'balance_invoice_missing'` for UNDER and `'invoice_over_bill'` for OVER, details carrying the cents figure and the non-void invoice labels.
- One batched `notifyAdminCategory({ category: 'payment_failure', ... })` per run covering newly alerted proposals, over-billed listed first. Throttle to once per 24h per proposal using `balanceScheduler.js:158-180`'s exact pattern: skip if an activity row for that proposal with `details->>'admin_notified' = 'true'` exists inside `NOW() - INTERVAL '24 hours'`, then stamp the marker with `SET details = details || jsonb_build_object('admin_notified', true)` on send.

Log one summary line per run: `[balance_invoice_monitor] candidates=N alerted=M throttled=K`.

- [ ] **Step 4: Run the suite**

Run: `node -r dotenv/config --test server/utils/balanceInvoiceMonitor.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/utils/balanceInvoiceMonitor.js server/utils/balanceInvoiceMonitor.test.js
git commit -m "feat(money): balance-invoice monitor, alert-only, both directions"
```

---

### Task 5: Wire the scheduler and update docs

**Files:**
- Modify: `server/index.js` (scheduler block, after the `RUN_QUOTE_DRAFT_CLEANUP_SCHEDULER` stanza at ~line 482-487)
- Modify: `.env.example`, `.claude/CLAUDE.md` (Environment Variables table), `README.md` (folder tree + env table), `ARCHITECTURE.md` (payments section)

**Interfaces:**
- Consumes: `monitorMissingBalanceInvoices` from Task 4.

- [ ] **Step 1: Add the scheduler stanza**

Follow the exact shape of the neighboring stanzas:

```js
      if (enabled('RUN_BALANCE_INVOICE_MONITOR')) {
        const wrapped = wrapScheduler('balance_invoice_monitor', 3600, monitorMissingBalanceInvoices);
        setTimeout(wrapped, 300000);
        setInterval(wrapped, 60 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('balance_invoice_monitor');
      }
```

The 300000ms first-run delay staggers it off the boot burst. The top-level catch inside `monitorMissingBalanceInvoices` must **rethrow** after logging and capturing, per the `wrapScheduler` contract in `server/utils/schedulerHealth.js`. Without the rethrow, `scheduler_health` reads `ok` while the query fails forever.

- [ ] **Step 2: Verify the server boots with the scheduler off and on**

```bash
RUN_SCHEDULERS=false node -r dotenv/config server/index.js
```
Expected: boots clean, no monitor log line. Kill it, then:
```bash
RUN_SCHEDULERS=true RUN_BALANCE_INVOICE_MONITOR=true node -r dotenv/config server/index.js
```
Expected: boots clean. The monitor's first run is 5 minutes out, so do not wait for it; you are checking that wiring does not throw at boot.

Note the dev server is a Claude-managed background process with no auto-reload. If one is already running on the port, stop it first rather than fighting `EADDRINUSE`.

- [ ] **Step 3: Update the four docs**

Add `RUN_BALANCE_INVOICE_MONITOR` to `.env.example`, the `README.md` env table, and the `.claude/CLAUDE.md` Environment Variables table, with this description: *"Optional. Set to `false` to disable the hourly balance-invoice monitor (alerts when a client is billed more than they owe, or has a balance with no payable invoice). Default on. Honored only when `RUN_SCHEDULERS` is not `false`."*

Add `balanceInvoiceMonitor.js` to the `README.md` folder tree, and a prose mention alongside `balanceScheduler` in the `ARCHITECTURE.md` payments section.

- [ ] **Step 4: Commit**

```bash
git add server/index.js .env.example .claude/CLAUDE.md README.md ARCHITECTURE.md
git commit -m "feat(money): wire balance-invoice monitor hourly behind RUN_BALANCE_INVOICE_MONITOR"
```

- [ ] **Step 5: Deployment gate, after ship**

After Lane 1 ships and the Task 3 remediation runs against prod, the monitor's first prod run must alert on **nothing**. If it alerts, that is a real finding, not a false positive: read it before silencing it.

---

## Lane 3: `invoice-void-ui`

Independent of both other lanes. Client-only, so verify with `CI=true react-scripts build` from `client/`, which is what the Vercel CI gate runs and what `.husky/pre-push` enforces.

### Task 6: Void and due-date actions on open invoices

**Files:**
- Modify: `client/src/pages/admin/ProposalDetailPaymentPanel.js:350-380` (the Invoices block)

**Interfaces:**
- Consumes: the existing `PATCH /api/invoices/:id` endpoint (`server/routes/invoices.js:281`), which accepts `{ label?, due_date?, status? }` where `status` may only be `'void'`. No server change in this lane.

Context: the endpoint has existed and been guarded since before this incident, and **nothing in `client/src` has ever called it**. That is the literal reason "we cannot edit invoices". This task is wiring, not new capability. The server already rejects a void on a locked invoice and on any invoice with `amount_paid > 0`, so the destructive cases are covered server-side; the UI must still surface those errors rather than swallow them.

- [ ] **Step 1: Add the void handler**

Alongside the existing `setSendInvoice` handler, add:

```js
  const [voidingId, setVoidingId] = useState(null);

  const handleVoidInvoice = async (inv) => {
    if (!window.confirm(`Void ${inv.invoice_number} (${inv.label})? This cannot be undone.`)) return;
    setVoidingId(inv.id);
    try {
      await api.patch(`/invoices/${inv.id}`, { status: 'void' });
      setInvoiceRefreshKey((k) => k + 1);
      await reloadInvoices();
    } catch (err) {
      window.alert(err.response?.data?.error || 'Could not void this invoice.');
    } finally {
      setVoidingId(null);
    }
  };
```

Match the file's existing state-setter and reload names; read the surrounding handlers (the refund and record-payment ones near lines 132 and 230) and mirror whichever refresh mechanism they use rather than inventing `reloadInvoices` if it does not exist.

- [ ] **Step 2: Render the button**

Inside the `sendableInvoices.map(...)` row, after the existing Send button, add:

```jsx
                  <button type="button" className="btn btn-ghost btn-sm"
                    disabled={voidingId === inv.id}
                    onClick={() => handleVoidInvoice(inv)}>
                    {voidingId === inv.id ? 'Voiding…' : 'Void'}
                  </button>
```

- [ ] **Step 3: Verify in the browser**

Start the dev server and open a proposal with an open invoice. Confirm: the Void button appears next to Send; voiding an open unpaid invoice removes it from the list; and attempting to void an invoice with payments applied surfaces the server's "Cannot void an invoice with payments applied" message in the alert rather than failing silently.

Do this against a scratch proposal you create, not a real client's.

- [ ] **Step 4: Run the CI-equivalent build**

```bash
cd client && CI=true npx react-scripts build
```
Expected: build succeeds. `CI=true` makes ESLint warnings fatal, which is what Vercel does and what nothing else local catches.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/admin/ProposalDetailPaymentPanel.js
git commit -m "feat(admin): void action on open invoices, wiring the existing PATCH endpoint"
```

---

## Self-review notes

**Spec coverage.** §1 → Tasks 1-2. §2 → Tasks 4-5. §3 → Task 6 (due-date editing is folded into the same panel change; if it adds scope, ship Void alone, it is the part that unblocks void-and-recreate). §4 → Task 3. The spec's `PARTIAL_BILL_LABELS` refinement is Task 1.

**Known gaps carried from the spec, deliberately not tasked.** The seven locked-unpaid `Balance` invoices are not protected by Lane 1 and are covered only by Lane 2's alerting. The `refreshUnlockedInvoices` vs `lab.js:418-457` locked-total inconsistency is untouched. Backfilling missing Deposit invoices for historical proposals is out of scope, which means the David shape can recur on other old proposals until the monitor catches it.

**Ordering risk.** Lane 1 Task 2 changes a function called from four production paths including the Stripe-adjacent drink-plan submit. Its Step 5 suite list is the gate; an unexplained failure there stops the lane rather than being worked around.
