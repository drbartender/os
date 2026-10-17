---
spec: docs/superpowers/specs/2026-10-16-price-override-removal-design.md   # approved in sections 2026-10-14..16, fleet folded c8b6eb94
pushes:
  push-1: [adj-rules, client-rows, editor, line-protection, refund-line, invoice-step, fold-holds, conversion-tooling]
  step-2: conversion run on prod (runbook in lane conversion-tooling; Dallas's go on the dry run)
  push-2: [override-removal]
lanes:
  - id: adj-rules
    footprint:
      - server/utils/adjustmentRules.js
      - server/utils/adjustmentRules.test.js
      - client/src/utils/adjustmentRules.js
      - ARCHITECTURE.md
      - README.md
      - scripts/sensitive-paths.txt
    blockedBy: []
    review: full-fleet   # the one definition of a money line's shape and protection
  - id: client-rows
    footprint:
      - server/utils/foldDecision.js
      - server/utils/foldDecision.test.js
      - server/utils/invoiceLineItems.js
      - server/utils/clientPriceLines.js
      - server/utils/clientPriceLines.test.js
      - server/utils/publicSnapshot.js
      - server/utils/publicSnapshot.test.js
      - server/routes/proposals/publicToken.js
      - server/routes/proposals/publicToken.*.test.js
      - server/routes/proposals/publicLeak.test.js
      - server/routes/drinkPlans.js
      - server/routes/clientPortal.js
      - server/routes/clientPortal/summary.js
      - server/routes/clientPortal*.test.js
      - server/utils/changeRequestNotifications.js
      - client/src/pages/proposal/proposalView/ProposalView.js
      - client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js
      - client/src/pages/proposal/proposalView/*.test.js
      - client/src/pages/public/portal/tabs/PrescriptionTab.js
      - client/src/pages/public/portal/tabs/PrescriptionTab.test.js
      - client/src/pages/public/portal/constants.js
      - ARCHITECTURE.md
      - README.md
      - docs/walkthroughs-owed.md
      - scripts/sensitive-paths.txt
    blockedBy: [adj-rules]
    review: full-fleet   # public payloads and the client's money display
  - id: editor
    footprint:
      - server/routes/proposals/patchGuards.js
      - server/routes/proposals/patchGuards.test.js
      - server/routes/proposals/crud.js
      - server/routes/proposals/crud*.test.js
      - server/routes/proposals/getOne.js
      - client/src/pages/admin/proposalEditor/**
      - client/src/components/mobile/useEditSheet.js
      - client/src/components/mobile/*EditSheet*.js
      - client/src/pages/admin/RemoteStaffingFeePrompt.js
      - client/src/pages/admin/ProposalDetail.js
      - client/src/pages/admin/EventDetailPage.js
      - client/src/index.css
      - ARCHITECTURE.md
      - README.md
      - docs/walkthroughs-owed.md
      - scripts/sensitive-paths.txt
    blockedBy: [adj-rules]
    review: full-fleet   # the money PATCH
  - id: line-protection
    footprint:
      - server/utils/pricingEngine.js
      - server/utils/pricingEngine*.test.js
      - server/utils/lineItemCancel.js
      - server/utils/lineItemCancel*.test.js
      - client/src/utils/hiddenRows.js
      - client/src/utils/hiddenRows.test.js
      - client/src/components/PricingBreakdown.js
      - client/src/components/PricingBreakdown*.test.js
      - client/src/utils/eventDetailView.js
      - client/src/utils/eventDetailView.test.js
      - client/src/pages/mobile/EventDetailPhone.js
      - client/src/index.css
      - README.md
      - docs/walkthroughs-owed.md
    blockedBy: [adj-rules]
    review: full-fleet   # cancel-line is a money writer
  - id: refund-line
    footprint:
      - server/utils/refundLine.js
      - server/utils/refundLine.test.js
      - server/utils/refundHelpers.js
      - ARCHITECTURE.md
      - README.md
      - scripts/sensitive-paths.txt
    blockedBy: [adj-rules]
    review: full-fleet   # refunds
  - id: invoice-step
    footprint:
      - server/utils/invoiceStep.js
      - server/utils/invoiceStep.test.js
      - server/routes/invoices.js
      - server/routes/invoices*.test.js
      - client/src/pages/invoice/InvoicePage.js
      - client/src/pages/invoice/InvoicePage*.test.js
      - client/src/index.css
      - ARCHITECTURE.md
      - README.md
      - docs/walkthroughs-owed.md
      - scripts/sensitive-paths.txt
    blockedBy: []
    review: full-fleet   # public invoice route
  - id: fold-holds
    footprint:
      - server/utils/proposalExtrasFold.js
      - server/utils/proposalExtrasFold*.test.js
      - server/routes/proposals/publicSwitch.js
      - server/routes/proposals/publicSwitch*.test.js
      - server/utils/lineItemCancel.test.js
      - ARCHITECTURE.md
    blockedBy: []
    review: full-fleet   # the client-triggered re-pricing writer
  - id: conversion-tooling
    footprint:
      - scripts/override-conversion/**
      - docs/runbooks/override-conversion.md
      - README.md
      - scripts/sensitive-paths.txt
    blockedBy: [adj-rules, fold-holds, refund-line]
    review: full-fleet   # produces the prod write
  - id: override-removal
    footprint:
      - server/**
      - client/src/**
      - scripts/cc-transfer-events.js
      - scripts/cc-transfer-events.test.js
      - scripts/cc-balance-invoice.js
      - server/db/schema.sql
      - ARCHITECTURE.md
      - README.md
    blockedBy: [client-rows, editor, line-protection, refund-line, invoice-step, fold-holds, conversion-tooling, STEP-2-CONFIRMED]
    review: full-fleet
---

# Price Override Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire `total_price_override`: every price difference becomes a fixed-dollar adjustment line, hidden lines fold so every client view adds up, refunds write a Refund line, Deposit/Balance invoices show the step to their total, and 37 existing overrides (plus 7 refund gaps) are converted without moving a total.

**Architecture:** One shared definition of a money line (`adjustmentRules`, server plus a client twin). One pure server builder turns a pricing snapshot into the rows a client sees, folding hidden amounts with the invoice rule; the public routes send those rows and a sanitized snapshot. Editor saves are guarded (staleness, legal hold, override, validation). Refunds append a marked line in the reconciliation transaction. The conversion is a tested transform that emits a guarded DO block run by hand on prod after Dallas reads its dry run; the override code is deleted in a second push.

**Tech Stack:** Node 26 + Express + pg (raw SQL); server tests `node:test` against the shared dev DB; React 18 (CRA) with Jest + React Testing Library; Neon (MCP `run_sql` for prod reads and the one DO block; the Neon REST API with `NEON_API_KEY` for a prod branch).

**Spec:** `docs/superpowers/specs/2026-10-16-price-override-removal-design.md` (commit c8b6eb94). Executors read the spec section each task names.

## Proven context (read on main 2026-10-16; anchors are that day's line numbers)

- Tests: server `node --test <file>` from the repo root, one suite at a time (they share the dev DB, `README.md:785`); framework `node:test` (`invoiceLineItems.test.js:10`); DB tests take `pool` from `server/db`, refuse `NODE_ENV=production`, track created ids, delete in FK order in `after()`, then `pool.end()` (`invoiceLineItems.test.js:14-30`; route-level exemplar `crud.test.js:203-358`, real routers on `express()` + `app.listen(0)`). Client: `cd client && CI=true npx react-scripts test --watchAll=false --testPathPattern=<name>`.
- Engine (`server/utils/pricingEngine.js`): `safeAdjustments` L475; `adjustmentNet` L476-479 (`Math.abs(Number(adj.amount) || 0)`, discount negative); `calculatedTotal` L480; `serviceTotal` / `total` L488-491; breakdown adjustment rows L574-580 (no `visible`); snapshot stores `adjustments` L637, `total_price_override` L638, `subtotal` L639.
- Editor PATCH (`server/routes/proposals/crud.js`, 958 lines, hard cap 1000): route L322; body destructure L328-332 (`change_request_id` at L332: change-request APPROVAL happens inside this PATCH, L711-727); old row `FOR UPDATE` L359; pkg L387-392; add-ons L398-409 (active catalog filtered by body `addon_ids`, quantity `safeAddonQty`); syrups L411-413; contract hours L417-419; `adj` L421 (wholesale replace); `tpo` L422; override bounds L463-470; `calculateProposal` L535-541; UPDATE L556-560 (values L578); status reconcile L608-629; addons replaced L653-667; activity L670-671 (stores only `new_total`); invoices L781-797; `res.json` L917.
- Admin GET one proposal: `server/routes/proposals/getOne.js:23` (`SELECT p.*`, so `updated_at` is present), `res.json` L107-150. Loaded by `ProposalDetail.js:121-133` and `EventDetailPage.js:66,78,125`; editor seeded by `initialFormFromProposal` (`formState.js`, keys L13-62, no `updated_at`); body built by `buildProposalPatchBody` (`patchBody.js:27-81`, `adjustments` L44, `total_price_override` L45, `change_request_id` L80); PATCH sent `ProposalEditorForm.js:363`. Other users of `buildProposalPatchBody`: `RemoteStaffingFeePrompt.js` (GET L103, PATCH L133) and the phone sheet `components/mobile/useEditSheet.js`.
- Public payload: `buildPublicProposalPayload` `publicToken.js:98` (exported L628), SELECT L105-118, deletes L250-262 (`total_price_override` at L259), `options_available` predicate L238-239. `publicSwitch.js` calls it at L598 (`res.json` L602), refuses overrides at L177-182 with `ConflictError(UNAVAILABLE_MSG, 'SWITCH_NOT_AVAILABLE')`, re-prices with `priceProposedState` L365-371, writes L416-423. `GET /api/drink-plans/t/:token` selects `p.pricing_snapshot` at `drinkPlans.js:52`.
- Portal: detail route `clientPortal.js:102`, columns L107-117 (raw `p.total_price_override` at L117, no snapshot), `res.json({ proposal: { ...proposal, addons, payments } })` L167-169 (it SPREADS the row: anything selected is returned). `PrescriptionTab.js:65-70` (add-ons L65-66, Total L68 reads `focus.total_price`); `focus` from `/home` via `shapeFocus` (`clientPortal/summary.js:19-20`, `r.total_price_override ?? r.total_price`); `constants.js:15`; archive `COALESCE` `clientPortal.js:84`.
- Proposal page rows: `ProposalView.js` (913 lines) `lineItems` memo L580-620 (package `base_cost + staffing.total` L584-585, hidden skipped L605, gratuity L612-617); rendered `ProposalPricingBreakdown.js:98-117`.
- Invoices: `foldToContract` `invoiceLineItems.js:22-67` (private; exports L326-330); fallback test `invoiceLineItems.test.js:141-151`. Public invoice route `invoices.js:27-183`: base SELECT L31-45 (no `total_price`), `Promise.all` L54-140 (`lineItemsRes`, `paymentsRes`, `refundsRes`, `extRes`, `inFlight`), `res.json({ invoice: { ...invoice, line_items, payments, refunds, extension, pending_payment, pending_payment_for_this_invoice } })` L172-182 (spreads the row). Totals block `InvoicePage.js:362-377` ("Invoice Total", "Amount Paid", "Balance Due"; cents via `formatCurrency`).
- Cancel-line: `computeCancelTargets` `lineItemCancel.js:98-265` (adjustment targets L244-251, all `cancellable: true`); execute path `applyLineItemCancel` L427 (adjustment branch about L575; no server check of `cancellable`). Client `matchCancelTargets` `PricingBreakdown.js:11-66` binds by label + cents; `cancellable` only filters the unmatched strip (L64); render L85 disables only `reason === 'orphaned_addon'`, else an enabled remove button (L95-101).
- Fold: `proposalExtrasFold.js` exports L252 (`foldExtrasIntoProposal`, `loadRepriceAddons`, `withRepriceQuantities`); override branch L131-190; native final compute L193-205; write L213-216. Callers: `lineItemCancel.js:613`, `drinkPlans/submit.js:450` (pkg L405-406, addons L291/L404 via `loadRepriceAddons`, syrups L292/L409-442), `drinkPlans/lab.js:344`.
- Refunds: `applyRefundReconciliation` `refundHelpers.js` (877 lines): row lock L322-326, already-applied return L333, invoice walk L407-530, `contractCents` L565, money UPDATE L596-604. Callers: `refundExecute.js:179`, `refundSweepScheduler.js:78`, `stripeWebhookHandlers/refundCreated.js:206`.
- `proposals` has a BEFORE UPDATE trigger setting `updated_at` (`schema.sql:890-891`, `update_updated_at_column` at L4): every UPDATE bumps it.
- `LEGAL_HOLD_PROPOSAL_IDS` `staleProposalSweep.js:47`; import pattern `const { LEGAL_HOLD_PROPOSAL_IDS } = require('../staleProposalSweep');` with the list injectable as a default parameter (`inbox/readJob.js:201`, `inbox/engine.js:78`).
- Twin parity precedent: `agreementVersions.test.js:15-21` loads a client ESM module with `import(pathToFileURL(...).href)` and compares behavior.

## Plan decisions

1. **Ten lanes collapse to two pushes.** Push 1 is every lane except `override-removal`; nothing in it depends on the conversion, and the override keeps working through it. Step 2 is the runbook in `conversion-tooling`. Push 2 is `override-removal`, cut only after Step 2's confirmation query is clean.
2. **`adj-rules` goes first and is small** (one server module, its client twin, one test file) so five lanes can share one definition of a line without a dependency chain between them.
3. **New logic lives in new files** where the touched file is near the cap: `patchGuards.js` beside `crud.js` (958), `refundLine.js` beside `refundHelpers.js` (877), `clientPriceLines.js` replacing the memo in `ProposalView.js` (913, which shrinks). `crud.js` gains call lines only and must stay under 1000.
4. **Client-facing refusals never say "legal hold".** Public and client-triggered paths (switch, drink-plan submit, Lab) reuse a generic "can't be changed online" refusal; only admin surfaces name the hold.
5. **Invoice copy casing follows the page.** The existing rows are title case ("Invoice Total", "Amount Paid", "Balance Due"), so the new ones read "Contract Total" and "Invoice Total"; the three step labels keep the spec's wording ("Balance, billed later", "Less deposit and earlier payments", "Less payments already received").
6. **The public fold never sends its gap.** The gap IS the hidden net; only the rows leave the server.
7. **Staleness is compared in milliseconds through `Date.getTime()`.** `pg` parses `timestamptz` into a JS `Date` (milliseconds), and the client echoes that ISO string, so equal rows compare equal and a microsecond difference cannot cause a false refusal.

## Global Constraints

- No em dashes anywhere (copy, comments, commits, docs). No client PII in fixtures, docs or commits: synthetic labels ("Test discount A"), synthetic amounts, ids only.
- Money compares in integer cents (`Math.round(Number(x) * 100)`); `proposals.total_price` and adjustment amounts are DOLLARS; `invoice_line_items.line_total` and `invoices.amount_due` are CENTS; `proposal_refunds.amount` is CENTS.
- Raw parameterized SQL only; handlers `asyncHandler`; client-visible errors are `AppError` subclasses (`ValidationError`, `ConflictError`) from `server/utils/errors.js`.
- One pooled connection per request: a handler holding `pool.connect()` uses that client for every query until release.
- File-size ratchet: no touched file may cross 1000 lines in a growing commit (`node scripts/check-file-size.js --staged`).
- Explicit `git add <path>` only; commit messages via `-F` heredoc, no backticks; trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and the session line.
- Proposal 600 is never written by any test, script or block in this plan. Tests inject legal-hold ids; nothing uses id 600.
- Dev talks to live Stripe: no test in this plan creates a real refund; refund tests drive `applyRefundReconciliation` directly with fixture rows.
- Every new server module under `server/utils/` or `server/routes/` gets its README tree line and an ARCHITECTURE mention in the same lane; every new money file gets a `scripts/sensitive-paths.txt` line (confirm with `node scripts/sensitive-match.js <path>`).

## Review Focus

1. **Two saves in a row from one open editor.** The second save must not be refused as stale: after a successful PATCH the form adopts the response's `updated_at`. Test owned by Task E4.
2. **A gratuity election re-quote on a hidden-discount booking.** After `applyIntentQuote` rewrites `snapshot.total` and `snapshot.gratuity`, the server rows plus the re-quoted gratuity row still equal the shown Total. Test owned by Task C5.
3. **A refund on a booking whose snapshot already drifted from `total_price`** (the 59 shape). The line is written, the snapshot total drops by the same amount, and the page still adds up to its own Total. Test owned by Task R2.
4. **A booking with one overpayment-scope and one contract-scope refund.** Only the contract refund writes a line, and the backfill matcher leaves the overpayment refund alone. Tests owned by Tasks R2 and V2.
5. **The phone edit sheet after a server-written Refund line.** The sheet's save is refused as stale and offers a reload; it never erases the line. Test owned by Task E4.

---

## Lane adj-rules

### Task A1: The money-line rules, server and client

**Files:**
- Create: `server/utils/adjustmentRules.js`, `server/utils/adjustmentRules.test.js`, `client/src/utils/adjustmentRules.js`
- Modify: `README.md` (utils tree, server and client), `ARCHITECTURE.md` (pricing section, one paragraph), `scripts/sensitive-paths.txt`

**Interfaces:**
- Produces (server, CJS) and the same names in the client twin (ESM, minus `validateAdjustments`):
  - `ADJUSTMENT_SOURCES = ['agreed_price', 'refund']`, `AGREED_PRICE_LABEL = 'Agreed price adjustment'`, `REFUND_LABEL = 'Refund'`, `MAX_ADJUSTMENTS = 50`, `MAX_ADJUSTMENT_DOLLARS = 1000000` (exclusive), `MAX_ADJUSTMENT_LABEL = 255`
  - `adjVisible(adj) -> boolean`, `adjAmount(adj) -> number (dollars, >= 0)`, `adjSignedCents(adj) -> integer`, `adjLabel(adj) -> string`, `isProtectedAdjustment(adj) -> boolean`
  - server only: `validateAdjustments(input) -> { value: Adjustment[] | null, error: string | null }`

- [ ] **Step 1: Write the failing server test**

```js
// server/utils/adjustmentRules.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const R = require('./adjustmentRules');

test('coercions match the engine (pricingEngine.js L476-479)', () => {
  assert.equal(R.adjVisible({ visible: true }), true);
  assert.equal(R.adjVisible({}), false);               // missing = hidden
  assert.equal(R.adjVisible({ visible: 'yes' }), true);
  assert.equal(R.adjAmount({ amount: '12.5' }), 12.5);
  assert.equal(R.adjAmount({ amount: -7 }), 7);
  assert.equal(R.adjAmount({ amount: 'x' }), 0);
  assert.equal(R.adjSignedCents({ type: 'discount', amount: 162 }), -16200);
  assert.equal(R.adjSignedCents({ type: 'surcharge', amount: '0.1' }), 10);
  assert.equal(R.adjSignedCents({ type: 'weird', amount: 5 }), 500); // non-discount = surcharge
  assert.equal(R.adjLabel({ type: 'discount' }), 'Discount');
  assert.equal(R.adjLabel({ type: 'surcharge', label: '' }), 'Surcharge');
  assert.equal(R.adjLabel({ type: 'discount', label: 'Test A' }), 'Test A');
});

test('protection is by source, never by label', () => {
  assert.equal(R.isProtectedAdjustment({ source: 'refund', label: 'Anything' }), true);
  assert.equal(R.isProtectedAdjustment({ source: 'agreed_price' }), true);
  assert.equal(R.isProtectedAdjustment({ label: 'Refund' }), false);
  assert.equal(R.isProtectedAdjustment(null), false);
});

test('validateAdjustments normalizes and keeps only known keys', () => {
  const { value, error } = R.validateAdjustments([
    { type: 'discount', label: 'Test A', amount: '100.005', visible: 0, extra: 'drop me' },
    { type: 'surcharge', label: '', amount: 5, visible: true, source: 'agreed_price' },
    { type: 'discount', label: 'Refund', amount: 20, visible: true, source: 'refund', refund_id: 14 },
  ]);
  assert.equal(error, null);
  assert.deepEqual(value, [
    { type: 'discount', label: 'Test A', amount: 100.01, visible: false },
    { type: 'surcharge', label: '', amount: 5, visible: true, source: 'agreed_price' },
    { type: 'discount', label: 'Refund', amount: 20, visible: true, source: 'refund', refund_id: 14 },
  ]);
});

test('validateAdjustments refuses bad input with one message', () => {
  const bad = [
    'not an array',
    Array.from({ length: 51 }, () => ({ type: 'discount', label: '', amount: 1, visible: true })),
    [{ type: 'gift', label: '', amount: 1, visible: true }],
    [{ type: 'discount', label: '', amount: -1, visible: true }],
    [{ type: 'discount', label: '', amount: 1000000, visible: true }],
    [{ type: 'discount', label: '', amount: 'abc', visible: true }],
    [{ type: 'discount', label: 'x'.repeat(256), amount: 1, visible: true }],
    [{ type: 'discount', label: 7, amount: 1, visible: true }],
    [{ type: 'discount', label: '', amount: 1, visible: true, source: 'other' }],
    [{ type: 'discount', label: '', amount: 1, visible: true, source: 'refund' }],            // refund needs refund_id
    [{ type: 'discount', label: '', amount: 1, visible: true, refund_id: 3 }],                // refund_id needs source refund
    [{ type: 'discount', label: '', amount: 1, visible: true, source: 'refund', refund_id: 0 }],
  ];
  for (const input of bad) {
    const { value, error } = R.validateAdjustments(input);
    assert.equal(value, null);
    assert.equal(typeof error, 'string');
  }
});

test('client twin behaves the same', async () => {
  const C = await import(pathToFileURL(path.join(__dirname, '../../client/src/utils/adjustmentRules.js')).href);
  for (const k of ['AGREED_PRICE_LABEL', 'REFUND_LABEL', 'MAX_ADJUSTMENTS', 'MAX_ADJUSTMENT_DOLLARS', 'MAX_ADJUSTMENT_LABEL']) {
    assert.deepEqual(C[k], R[k], k);
  }
  assert.deepEqual([...C.ADJUSTMENT_SOURCES], [...R.ADJUSTMENT_SOURCES]);
  const cases = [{}, { visible: true, type: 'discount', amount: '3.333', label: '' },
    { type: 'surcharge', amount: -2, label: 'Test B', source: 'refund' }, { type: 'x', amount: null }];
  for (const c of cases) {
    for (const fn of ['adjVisible', 'adjAmount', 'adjSignedCents', 'adjLabel', 'isProtectedAdjustment']) {
      assert.deepEqual(C[fn](c), R[fn](c), `${fn} ${JSON.stringify(c)}`);
    }
  }
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test server/utils/adjustmentRules.test.js`
Expected: FAIL, `Cannot find module './adjustmentRules'`.

- [ ] **Step 3: Implement the server module**

```js
// server/utils/adjustmentRules.js
'use strict';
// One definition of a price adjustment line (spec 2026-10-16 section 3).
// Coercions mirror pricingEngine.js adjustmentNet exactly; client twin:
// client/src/utils/adjustmentRules.js (parity pinned by the test).

const ADJUSTMENT_SOURCES = Object.freeze(['agreed_price', 'refund']);
const AGREED_PRICE_LABEL = 'Agreed price adjustment';
const REFUND_LABEL = 'Refund';
const MAX_ADJUSTMENTS = 50;
const MAX_ADJUSTMENT_DOLLARS = 1000000; // exclusive; the bound TOTAL_PRICE_OVERRIDE_MAX had
const MAX_ADJUSTMENT_LABEL = 255;      // invoice_line_items.description

const adjVisible = (adj) => !!(adj && adj.visible);
const adjAmount = (adj) => Math.abs(Number(adj && adj.amount) || 0);
const adjSignedCents = (adj) => {
  const cents = Math.round(adjAmount(adj) * 100);
  return adj && adj.type === 'discount' ? -cents : cents;
};
const adjLabel = (adj) => (adj && adj.label) || (adj && adj.type === 'discount' ? 'Discount' : 'Surcharge');
const isProtectedAdjustment = (adj) => !!adj && ADJUSTMENT_SOURCES.includes(adj.source);

function validateAdjustments(input) {
  const fail = (error) => ({ value: null, error });
  if (!Array.isArray(input)) return fail('Price adjustments must be a list.');
  if (input.length > MAX_ADJUSTMENTS) return fail(`At most ${MAX_ADJUSTMENTS} price adjustments.`);
  const value = [];
  for (const adj of input) {
    if (!adj || typeof adj !== 'object') return fail('Each price adjustment must be an object.');
    if (adj.type !== 'discount' && adj.type !== 'surcharge') return fail('Each price adjustment is a discount or a surcharge.');
    const label = adj.label === undefined || adj.label === null ? '' : adj.label;
    if (typeof label !== 'string') return fail('A price adjustment label must be text.');
    if (label.length > MAX_ADJUSTMENT_LABEL) return fail(`A price adjustment label is at most ${MAX_ADJUSTMENT_LABEL} characters.`);
    const n = typeof adj.amount === 'string' && adj.amount.trim() !== '' ? Number(adj.amount) : adj.amount;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n >= MAX_ADJUSTMENT_DOLLARS) {
      return fail('A price adjustment amount must be $0 or more and under $1,000,000.');
    }
    const line = { type: adj.type, label, amount: Math.round(n * 100) / 100, visible: !!adj.visible };
    if (adj.source !== undefined && adj.source !== null) {
      if (!ADJUSTMENT_SOURCES.includes(adj.source)) return fail('Unknown price adjustment source.');
      line.source = adj.source;
    }
    if (line.source === 'refund') {
      if (!Number.isInteger(adj.refund_id) || adj.refund_id <= 0) return fail('A refund line must name its refund.');
      line.refund_id = adj.refund_id;
    } else if (adj.refund_id !== undefined && adj.refund_id !== null) {
      return fail('Only a refund line can name a refund.');
    }
    value.push(line);
  }
  return { value, error: null };
}

module.exports = {
  ADJUSTMENT_SOURCES, AGREED_PRICE_LABEL, REFUND_LABEL,
  MAX_ADJUSTMENTS, MAX_ADJUSTMENT_DOLLARS, MAX_ADJUSTMENT_LABEL,
  adjVisible, adjAmount, adjSignedCents, adjLabel, isProtectedAdjustment,
  validateAdjustments,
};
```

- [ ] **Step 4: Implement the client twin** (`client/src/utils/adjustmentRules.js`): the same constants and the five pure functions as `export const`, header comment naming the server file and the parity test. No `validateAdjustments` (the server is the authority).

- [ ] **Step 5: Run the test and see it pass**

Run: `node --test server/utils/adjustmentRules.test.js`
Expected: PASS, 5 tests. Read the pass count.

- [ ] **Step 6: Docs and sensitive list.** README tree lines for both files; one ARCHITECTURE paragraph (pricing section: "adjustment lines, their `source`/`refund_id` markers, and the validation bound"); add both paths to `scripts/sensitive-paths.txt`, confirm with `node scripts/sensitive-match.js server/utils/adjustmentRules.js`.

- [ ] **Step 7: Commit** `git add server/utils/adjustmentRules.js server/utils/adjustmentRules.test.js client/src/utils/adjustmentRules.js README.md ARCHITECTURE.md scripts/sensitive-paths.txt` with message "feat(pricing): one definition of an adjustment line, with markers and validation".

---

## Lane client-rows

### Task C1: The shared fold decision

**Files:** Create `server/utils/foldDecision.js`, `server/utils/foldDecision.test.js`; Modify `server/utils/invoiceLineItems.js:50-65`.

**Interfaces:** Produces `decideFold({ hasPackage, packageCents, gapCents }) -> 'none' | 'skipped' | 'package' | 'fallback'`.

- [ ] **Step 1: Failing test**

```js
// server/utils/foldDecision.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decideFold } = require('./foldDecision');

test('the invoice rule', () => {
  assert.equal(decideFold({ hasPackage: true, packageCents: 30000, gapCents: 0 }), 'none');
  assert.equal(decideFold({ hasPackage: false, packageCents: 0, gapCents: -500 }), 'skipped');
  assert.equal(decideFold({ hasPackage: true, packageCents: 30000, gapCents: -30000 }), 'package'); // reaches exactly 0
  assert.equal(decideFold({ hasPackage: true, packageCents: 30000, gapCents: -30001 }), 'fallback');
  assert.equal(decideFold({ hasPackage: true, packageCents: 30000, gapCents: 7500 }), 'package');
});
```

- [ ] **Step 2:** `node --test server/utils/foldDecision.test.js`, expect FAIL (module missing).
- [ ] **Step 3: Implement**

```js
// server/utils/foldDecision.js
'use strict';
// Where a gap between itemized lines and a total goes (spec 2026-10-16 D3).
// Shared by invoiceLineItems.foldToContract and clientPriceLines.
function decideFold({ hasPackage, packageCents, gapCents }) {
  if (gapCents === 0) return 'none';
  if (!hasPackage) return 'skipped';
  return packageCents + gapCents >= 0 ? 'package' : 'fallback';
}
module.exports = { decideFold };
```

- [ ] **Step 4:** In `foldToContract`, replace `if (gap === 0) return fold; if (packageItem.line_total + gap >= 0) {` with `const verdict = decideFold({ hasPackage: true, packageCents: packageItem.line_total, gapCents: gap }); if (verdict === 'none') return fold; if (verdict === 'package') {`. Behavior must be byte-identical.
- [ ] **Step 5:** `node --test server/utils/foldDecision.test.js` then `node --test server/utils/invoiceLineItems.test.js`; expect both PASS with their previous counts (the fallback case L141-151 included).
- [ ] **Step 6: Commit** the three files: "refactor(invoices): the fold decision becomes a shared pure function".

### Task C2: The client-rows builder

**Files:** Create `server/utils/clientPriceLines.js`, `server/utils/clientPriceLines.test.js`.

**Interfaces:**
- Consumes: `decideFold` (C1); `adjVisible`, `adjSignedCents`, `adjLabel` (A1).
- Produces: `buildClientPriceRows(snapshot, { targetCents, packageName }) -> { rows: Array<{ key: string, label: string, amount: number /* dollars */ }>, fold: { applied: 'no_total' | 'none' | 'skipped' | 'package' | 'fallback', gapCents: number } }`. Rows are SERVICE rows only (no gratuity).

- [ ] **Step 1: Characterize today's page rows.** Before writing the builder, copy the body of `ProposalView.js`'s `lineItems` memo (L580-620) into the test file as a local function `legacyRows(snap, packageName)` that returns the same rows minus the gratuity row (L612-617), and freeze three synthetic snapshots as fixtures: (a) flat package with bar rental, two add-ons (one $0), syrups, one visible discount; (b) hosted package with staffing; (c) no adjustments. The builder must reproduce `legacyRows` exactly (same keys, labels, dollar amounts, order) whenever the snapshot has no hidden adjustment.
- [ ] **Step 2: Failing tests**

```js
// server/utils/clientPriceLines.test.js (excerpt; legacyRows and FIXTURES from Step 1 above it)
const cents = (rows) => rows.reduce((s, r) => s + Math.round(r.amount * 100), 0);

test('no hidden lines: identical to the page today', () => {
  for (const snap of FIXTURES) {
    const target = Math.round((snap.total - (snap.gratuity?.total || 0)) * 100);
    const { rows, fold } = buildClientPriceRows(snap, { targetCents: target, packageName: 'Test Package' });
    assert.deepEqual(rows, legacyRows(snap, 'Test Package'));
    assert.equal(fold.applied, 'none');
  }
});

test('a hidden discount folds into the package and the rows reach the target', () => {
  const snap = withHidden(FIXTURES[0], { type: 'discount', label: 'Test hidden', amount: 100, visible: false });
  const target = Math.round((snap.total - (snap.gratuity?.total || 0)) * 100);
  const { rows, fold } = buildClientPriceRows(snap, { targetCents: target, packageName: 'Test Package' });
  assert.equal(fold.applied, 'package');
  assert.equal(cents(rows), target);
  assert.ok(!rows.some(r => r.label === 'Test hidden'));
});

test('a hidden discount bigger than the package uses one Pricing adjustment row', () => {
  const snap = withHidden(FIXTURES[0], { type: 'discount', label: 'Test hidden', amount: 5000, visible: false });
  const target = Math.max(0, Math.round((snap.total - (snap.gratuity?.total || 0)) * 100));
  const { rows, fold } = buildClientPriceRows(snap, { targetCents: target, packageName: 'Test Package' });
  assert.equal(fold.applied, 'fallback');
  assert.equal(rows.at(-1).label, 'Pricing adjustment');
  assert.equal(cents(rows), target);
});

test('no total means no rows; no package means no fold', () => {
  assert.deepEqual(buildClientPriceRows({}, { targetCents: NaN }).rows, []);
  assert.equal(buildClientPriceRows(null, { targetCents: 0 }).fold.applied, 'no_total');
  const noPkg = { ...FIXTURES[0], package: undefined };
  assert.equal(buildClientPriceRows(noPkg, { targetCents: 1 }).fold.applied, 'skipped');
});

test('legacy string amounts and odd types follow the engine', () => {
  const snap = withHidden(FIXTURES[2], { type: 'Discount', label: 'Test odd', amount: '25', visible: 'true' });
  // type 'Discount' is not 'discount': the engine treats it as a SURCHARGE; visible 'true' is truthy
  const target = Math.round((snap.total - (snap.gratuity?.total || 0)) * 100);
  const { rows } = buildClientPriceRows(snap, { targetCents: target, packageName: 'Test Package' });
  assert.equal(rows.find(r => r.label === 'Test odd').amount, 25);
});
```

(`withHidden(snap, adj)` is a test helper that appends `adj` to `snap.adjustments` and moves `snap.total` by `adjSignedCents(adj) / 100`, clamped at 0 the engine's way.)

- [ ] **Step 3:** `node --test server/utils/clientPriceLines.test.js`, expect FAIL (module missing).
- [ ] **Step 4: Implement.** Port `legacyRows` into the module as `itemizedRows(snapshot, packageName)` (package, bar rental, add-ons including $0, syrups, VISIBLE adjustments via `adjVisible`/`adjLabel`/`adjSignedCents`, in that order, dollars). Then:

```js
function buildClientPriceRows(snapshot, { targetCents, packageName } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || !Number.isFinite(Number(snapshot.total))
      || !Number.isFinite(targetCents)) {
    return { rows: [], fold: { applied: 'no_total', gapCents: 0 } };
  }
  const rows = itemizedRows(snapshot, packageName);
  const gapCents = targetCents - rows.reduce((s, r) => s + Math.round(r.amount * 100), 0);
  const pkg = rows.find(r => r.key === 'package');
  const applied = decideFold({ hasPackage: !!pkg, packageCents: pkg ? Math.round(pkg.amount * 100) : 0, gapCents });
  if (applied === 'package') pkg.amount = (Math.round(pkg.amount * 100) + gapCents) / 100;
  if (applied === 'fallback') rows.push({ key: 'pricing-adjustment', label: 'Pricing adjustment', amount: gapCents / 100 });
  return { rows, fold: { applied, gapCents } };
}
```

- [ ] **Step 5:** run the test file; expect PASS (5 tests). Read the count.
- [ ] **Step 6: Commit** "feat(pricing): server builder for the rows a client sees, hidden lines folded".

### Task C3: The public snapshot sanitizer and the field inventory

**Files:** Create `server/utils/publicSnapshot.js`, `server/utils/publicSnapshot.test.js`.

**Interfaces:** Produces `sanitizeSnapshotForPublic(snapshot) -> object | null`.

- [ ] **Step 1: Inventory, written into the module header.** Grep every public reader of the snapshot: `grep -rn "pricing_snapshot\|snapshot\.\|snap\." client/src/pages/proposal client/src/pages/plan client/src/pages/public client/src/components/proposal* | grep -v test`, plus the drink-plan page that consumes `GET /api/drink-plans/t/:token`. List every field read (for example `total`, `gratuity`, `package.name`, `staffing.actual`, `syrups.selections`, `addons[].rate`). The sanitizer keeps exactly those fields. If any reader needs `subtotal`, `breakdown`, `package.base_cost`, `staffing.total`/`staffing.cost` or any hidden adjustment once the page renders server rows, STOP and bring it to Dallas (spec 4.3); do not keep it silently.
- [ ] **Step 2: Failing test**

```js
test('hidden data never survives', () => {
  const snap = { total: 300, subtotal: 400, total_price_override: 300,
    package: { name: 'Test Package', base_cost: 400 }, staffing: { total: 0, actual: 1 },
    adjustments: [{ type: 'discount', label: 'Test secret', amount: 100, visible: false },
                  { type: 'surcharge', label: 'Test shown', amount: 5, visible: true }],
    breakdown: [{ label: 'Test secret', amount: -100 }], gratuity: { total: 0 } };
  const out = sanitizeSnapshotForPublic(snap);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('Test secret'));
  assert.ok(!('subtotal' in out) && !('breakdown' in out) && !('total_price_override' in out));
  assert.deepEqual(out.adjustments.map(a => a.label), ['Test shown']);
  assert.equal(snap.adjustments.length, 2); // input not mutated
});
test('null in, null out', () => assert.equal(sanitizeSnapshotForPublic(null), null));
```

Add one assertion per field the Step 1 inventory removed (for example `assert.ok(!('base_cost' in out.package))`).

- [ ] **Step 3:** run, FAIL. **Step 4:** implement as a deep clone (`structuredClone`) that deletes the removed keys and filters `adjustments` with `adjVisible`. **Step 5:** run, PASS. **Step 6: Commit** "feat(pricing): sanitized public copy of a pricing snapshot".

### Task C4: Public routes send rows and the sanitized snapshot

**Files:** Modify `server/routes/proposals/publicToken.js` (inside `buildPublicProposalPayload`, after L250-262), `server/routes/drinkPlans.js` (the `GET /t/:token` response around L52); Create `server/routes/proposals/publicLeak.test.js`.

**Interfaces:** Consumes C2, C3. Produces the payload field `price_rows: Array<{ key, label, amount }>` on the public proposal payload (and so on the switch response, which reuses the builder).

- [ ] **Step 1: Failing leak test** (route-level, `crud.test.js` harness pattern): insert a synthetic client and a `sent` proposal whose stored snapshot carries a hidden discount `{ label: 'Test leak label', amount: 123.45 }` and a pre-fold `subtotal` of 777.77; GET `/api/proposals/t/:token` and `/api/drink-plans/t/:token` (insert a drink plan row for the second); assert each serialized body contains none of `'Test leak label'`, `'123.45'`, `'777.77'`, `'total_price_override'`; assert `price_rows` sums (cents) to `snapshot.total - snapshot.gratuity.total`. Clean up in `after()`.
- [ ] **Step 2:** `node --test server/routes/proposals/publicLeak.test.js`, expect FAIL.
- [ ] **Step 3: Implement.** In `buildPublicProposalPayload`: `const snap = proposal.pricing_snapshot; const targetCents = snap ? Math.round((Number(snap.total) - Number(snap.gratuity?.total || 0)) * 100) : NaN; const { rows, fold } = buildClientPriceRows(snap, { targetCents, packageName: proposal.package_name });` then `publicProposal.price_rows = rows; publicProposal.pricing_snapshot = sanitizeSnapshotForPublic(snap);`. Report `fold.applied` of `'fallback'` or `'skipped'` to Sentry with the proposal id only (no amounts), throttled to once per proposal per process (a module-level `Set`), mirroring `reportFold` (`invoiceLineItems.js:216-242`). In `drinkPlans.js` replace the selected snapshot with `sanitizeSnapshotForPublic(row.pricing_snapshot)` before responding. Confirm `publicSwitch.js:598` still calls the builder (no edit there).
- [ ] **Step 4:** run the leak test, PASS; then `node --test` the existing `publicToken*.test.js` and `publicSwitch*.test.js` suites one at a time; all PASS (update any assertion that read a removed snapshot field, citing the inventory).
- [ ] **Step 5: Commit** "feat(proposals): public payloads carry folded rows and no hidden data".

### Task C5: The proposal page renders server rows

**Files:** Modify `client/src/pages/proposal/proposalView/ProposalView.js` (replace the memo L580-620), `ProposalPricingBreakdown.js` (if it reads row fields by another name); Test: the existing ProposalView test file (or create `ProposalView.rows.test.js`).

- [ ] **Step 1: Failing test:** render `ProposalView` with a mocked payload whose `price_rows` are `[{ key: 'package', label: 'Test Package', amount: 250 }, { key: 'addon-1', label: 'Test Add-on', amount: 50 }]` and `pricing_snapshot.total = 300`, `gratuity.total = 0`: the breakdown shows exactly those rows and Total $300. Second case (Review Focus 2): same payload with `gratuity: { total: 40 }` applied through the page's intent-quote path (`applyIntentQuote`) moving `total` to 340: rows plus the "Gratuity" row equal $340 on screen.
- [ ] **Step 2:** run (`--testPathPattern=ProposalView`), FAIL. **Step 3:** the memo becomes `const lineItems = useMemo(() => [...(proposal.price_rows || []), ...gratuityRow(snapshot)], [...])`, keeping today's gratuity row code (L612-617) as `gratuityRow`; delete the rest of the old memo. **Step 4:** run, PASS; the file must SHRINK. **Step 5: Commit** "feat(proposal page): render the server's folded rows".

### Task C6: Portal rows, totals, and the approved email

**Files:** Modify `server/routes/clientPortal.js` (detail route L102-170; archive L84), `server/routes/clientPortal/summary.js:19-20`, `client/src/pages/public/portal/constants.js:15`, `client/src/pages/public/portal/tabs/PrescriptionTab.js:65-70`, `server/utils/changeRequestNotifications.js:45`; Test: the portal route test file and `PrescriptionTab.test.js`.

- [ ] **Step 1: Failing tests.** Route: GET the portal detail for a synthetic proposal with a hidden discount; assert the response has `price_rows` summing (cents) to `total_price - gratuity`, `gratuity_amount`, and NO `pricing_snapshot`, `adjustments` or `total_price_override` keys anywhere (`JSON.stringify` check, as in C4). `/home` focus total equals `total_price` for a row with an override AND a gratuity. Client: PrescriptionTab renders the rows, a Gratuity row when `gratuity_amount > 0`, and Total from `focus.total_price`; rows plus gratuity equal Total.
- [ ] **Step 2:** run, FAIL. **Step 3: Implement.** Detail route: delete `p.total_price_override` from the column list (L117); fetch the snapshot in a SEPARATE query (`SELECT pricing_snapshot FROM proposals WHERE id = $1`) so the spread at L167-169 can never carry it; build rows with `targetCents = round((total_price - gratuity.total) * 100)`; respond with `price_rows` and `gratuity_amount`. `shapeFocus` and `constants.js` read `total_price` only; archive SQL drops the `COALESCE`. `changeRequestNotifications.js:45` passes `total_price`. PrescriptionTab renders `p.price_rows` then the gratuity row in place of the add-ons list. **Step 4:** run the route test and the client test; PASS. **Step 5: Commit** "feat(portal): the Prescription tab shows folded rows that add up; totals read total_price".

### Task C7: Docs, sensitive list, walkthroughs

- [ ] README tree lines for `foldDecision.js`, `clientPriceLines.js`, `publicSnapshot.js`; ARCHITECTURE: the public proposal payload, `GET /api/drink-plans/t/:token` and the portal detail route rows note the new fields and the sanitized snapshot. `scripts/sensitive-paths.txt` gains the three utils. `docs/walkthroughs-owed.md`: "Proposal page and portal with a hidden discount: rows add up, no hidden label in the page source (view-source and the network tab)". Commit "docs(pricing): client rows, sanitized payloads".

---

## Lane editor

### Task E1: The PATCH guards module

**Files:** Create `server/routes/proposals/patchGuards.js`, `server/routes/proposals/patchGuards.test.js`.

**Interfaces:**
- Consumes: `validateAdjustments` (A1), `LEGAL_HOLD_PROPOSAL_IDS`.
- Produces:
  - `assertNotLegalHold(proposalId, ids = LEGAL_HOLD_PROPOSAL_IDS)` throws `ConflictError('This booking is on legal hold and cannot be edited.', 'LEGAL_HOLD')`
  - `assertFreshEdit(body, oldRow)` throws `ConflictError('This booking changed since you opened it. Reload to see the latest.', 'STALE_EDIT')` when `body.adjustments !== undefined` and `expected_updated_at` is missing, unparseable, or `new Date(expected).getTime() !== new Date(oldRow.updated_at).getTime()`
  - `assertOverrideUnchanged(body, oldRow)` throws `ValidationError({ total_price_override: 'Price overrides are retired. Use Set agreed price.' })` when `body.total_price_override` is non-null and its cents differ from the stored value's cents (stored may be the string "3373.00"; body a Number or string)
  - `normalizeAdjustmentsOrThrow(adjustments)` returns the validated array or throws `ValidationError({ adjustments: error })`; passes `undefined` through

- [ ] **Step 1: Failing tests** covering: legal hold refused with an injected list `[999999]` and allowed otherwise; fresh edit accepted on an equal timestamp given as an ISO string with milliseconds, refused on a 1 ms difference, refused when missing with adjustments present, ignored when the body carries no adjustments; override accepted for `3373` vs stored `'3373.00'`, accepted for `'3373.00'` vs `'3373.00'`, refused for `3373.01`, accepted for `null` (clear) and for absent; adjustments normalized and a bad one refused with the field name.
- [ ] **Step 2:** `node --test server/routes/proposals/patchGuards.test.js`, FAIL. **Step 3:** implement (pure; no DB). **Step 4:** PASS. **Step 5: Commit** "feat(proposals): PATCH guards for staleness, legal hold, retired overrides, line validation".

### Task E2: Wire the guards into the PATCH; audit the lines; the GET flag

**Files:** Modify `server/routes/proposals/crud.js`, `server/routes/proposals/getOne.js`; Test: `server/routes/proposals/crud.test.js` (or a new `crud.guards.test.js` with the same harness).

- [ ] **Step 1: Failing route tests** (synthetic fixtures; the harness's `__setDeps` or a module-level setter injects the legal-hold list):
  1. PATCH with `adjustments` and a matching `expected_updated_at` saves; the response carries the new `updated_at`.
  2. Same body with an old `expected_updated_at` returns 409 `STALE_EDIT` and changes nothing.
  3. A row bumped by a direct `UPDATE proposals SET notes = notes WHERE id = $1` (the trigger moves `updated_at`) refuses the tab's next save.
  4. A legal-hold id returns 409 `LEGAL_HOLD` before any write, including with `change_request_id` (approval path).
  5. A changed override returns 400 on `total_price_override`; an equal one saves.
  6. A bad adjustment returns 400 on `adjustments`.
  7. The activity entry for a save that changed adjustments carries `old_adjustments` and `new_adjustments`.
  8. Regression for the original bug: a booking with a hidden agreed-price discount and no override; PATCH adding one hour raises `total_price` by exactly the catalog price of that hour.
- [ ] **Step 2:** run, FAIL. **Step 3: Implement** with call lines only: right after reading the id, `assertNotLegalHold(id)`; after the `FOR UPDATE` read (L359), `assertFreshEdit(req.body, old)` and `assertOverrideUnchanged(req.body, old)`; replace L421 with `const adj = normalizeAdjustmentsOrThrow(adjustments) ?? (old.adjustments || []);`; add the two arrays to the activity details at L670-671 when `JSON.stringify` differs; make sure the `res.json` at L917 includes `updated_at` (add it if absent). `getOne.js` adds `legal_hold: LEGAL_HOLD_PROPOSAL_IDS.includes(Number(p.id))` to its response. `wc -l crud.js` must stay under 1000.
- [ ] **Step 4:** run the new tests, then the existing crud suites one at a time; all PASS. **Step 5: Commit** "feat(proposals): the editor PATCH refuses stale tabs, legal holds and new overrides".

### Task E3: The agreed-price math

**Files:** Create `client/src/pages/admin/proposalEditor/agreedPrice.js`, `agreedPrice.test.js`.

**Interfaces:** Produces `parseAgreedCents(text) -> { cents, error }` and `applyAgreedPrice({ adjustments, previewServiceCents, agreedCents }) -> { adjustments, error }`.

- [ ] **Step 1: Failing tests**

```js
import { parseAgreedCents, applyAgreedPrice } from './agreedPrice';
const AP = (amount, type = 'discount', visible = false) =>
  ({ type, label: 'Agreed price adjustment', amount, visible, source: 'agreed_price' });

test('input rules', () => {
  for (const t of ['', ' ', 'abc', '-1', '1000000']) expect(parseAgreedCents(t).error).toBe('Enter a price of $0 or more');
  expect(parseAgreedCents('1,493.00')).toEqual({ cents: 149300, error: null });
  expect(parseAgreedCents('0')).toEqual({ cents: 0, error: null });
});
test('appends a hidden discount for a lower price', () => {
  const r = applyAgreedPrice({ adjustments: [], previewServiceCents: 165500, agreedCents: 149300 });
  expect(r.adjustments).toEqual([AP(162)]);
});
test('replaces its own line in place, keeping the admin visibility choice', () => {
  const start = [{ type: 'discount', label: 'Test other', amount: 10, visible: true }, AP(162, 'discount', true)];
  // preview already includes both lines: 165500 - 1000 - 16200 = 148300
  const r = applyAgreedPrice({ adjustments: start, previewServiceCents: 148300, agreedCents: 150000 });
  expect(r.adjustments).toEqual([start[0], AP(145, 'discount', true)]);
});
test('a higher price writes a surcharge; an equal price removes the line', () => {
  expect(applyAgreedPrice({ adjustments: [], previewServiceCents: 100000, agreedCents: 112500 }).adjustments)
    .toEqual([AP(125, 'surcharge')]);
  expect(applyAgreedPrice({ adjustments: [AP(50)], previewServiceCents: 95000, agreedCents: 100000 }).adjustments)
    .toEqual([]);
});
test('refuses to guess across the zero clamp', () => {
  const r = applyAgreedPrice({ adjustments: [AP(500)], previewServiceCents: 0, agreedCents: 10000 });
  expect(r.error).toMatch(/Remove the agreed price line/);
});
```

- [ ] **Step 2:** run (`--testPathPattern=agreedPrice`), FAIL. **Step 3: Implement**: `parseAgreedCents` strips `$`, commas and spaces, requires a finite number `>= 0` and `< MAX_ADJUSTMENT_DOLLARS`; `applyAgreedPrice` finds the index with `source === 'agreed_price'`, refuses when `previewServiceCents === 0` and that line exists with a discount (message "Remove the agreed price line, then set the price again."), backs out its `adjSignedCents`, computes `diff = agreedCents - base`, and removes, replaces in place (keeping `visible`) or appends a hidden line. **Step 4:** PASS. **Step 5: Commit** "feat(editor): agreed-price math".

### Task E4: The editor UI, the stale-save flow, the phone sheet and the staffing prompt

**Files:** Create `client/src/pages/admin/proposalEditor/AgreedPriceControl.js`; Modify `ProposalEditorForm.js` (remove L735-758; add the control after the adjustment buttons at about L677-684; refund-line confirm; legal-hold read-only; 409 handling), `formState.js` (add `expected_updated_at: proposal.updated_at || null`), `patchBody.js` (send `expected_updated_at`, stop sending `total_price_override`), `client/src/components/mobile/useEditSheet.js` (and the sheet component, for legal-hold read-only and the 409 reload), `client/src/pages/admin/RemoteStaffingFeePrompt.js` (pass the GET's `updated_at`), `client/src/index.css` (agreed-price row, reusing `.input`, `.btn`, `.hstack`); Tests: `patchBody.test.js`, `formState.test.js`, a new `AgreedPriceControl.test.js`, the phone sheet's test.

- [ ] **Step 1: Failing tests:**
  1. `patchBody` sends `expected_updated_at` and never `total_price_override`.
  2. AgreedPriceControl: Apply is disabled while `previewStale`, while `editPreview` is null, and when the booking still has an override (the form shows "Price override: $X. It converts to an Agreed price adjustment line soon." instead); helper text reads "Before gratuity. Gratuity is added on top." plus "Includes staffing gratuity." when the preview's staffing carries the forced Shared Gratuity (read the field the engine uses for it, `pricingEngine.js` about L170-180 and L603-610; name it in the test).
  3. Removing or lowering a `source: 'refund'` line shows the inline confirm "This line records money already refunded. Removing it bills that amount again." and changes nothing until confirmed.
  4. Review Focus 1: two successive saves in one open editor both succeed (the form adopts the PATCH response's `updated_at` after each save).
  5. A 409 `STALE_EDIT` shows the server's message with a Reload button that reloads the proposal.
  6. `legal_hold: true` renders "This booking is on legal hold and can't be edited here." and no Save, in the editor and in the phone sheet.
  7. Review Focus 5: the phone sheet sends `expected_updated_at`; a 409 shows the reload message and leaves the server row's lines alone (assert the sheet makes no second PATCH).
- [ ] **Step 2:** run each, FAIL. **Step 3: Implement** to the tests. `ProposalEditorForm.js` must not grow past 900 lines (extract into `AgreedPriceControl.js`). **Step 4:** run all touched client tests; PASS. **Step 5: Commit** "feat(editor): Set agreed price replaces the override; stale saves reload; legal hold is read-only".

### Task E5: Docs and walkthroughs

- [ ] README: `patchGuards.js`, `agreedPrice.js`, `AgreedPriceControl.js`; ARCHITECTURE: the PATCH route row notes `expected_updated_at`, the 409 codes and the adjustment validation; the GET row notes `legal_hold`. `scripts/sensitive-paths.txt`: `patchGuards.js`. `docs/walkthroughs-owed.md`: "Set agreed price on a dev booking (lower, higher, again, zero)"; "Open the editor, refund from another tab (or save from the phone), then save the first editor: refused with Reload". Commit "docs(editor): agreed price, stale saves, legal hold".

---

## Lane line-protection

### Task P1: The engine marks visibility on breakdown rows

**Files:** Modify `server/utils/pricingEngine.js:574-580`; Test: the engine's test file.

- [ ] **Step 1: Failing test:** `calculateProposal` with one visible and one hidden adjustment returns breakdown rows `{ label, amount, visible: true }` and `{ ..., visible: false }`; non-adjustment rows have no `visible` key.
- [ ] **Step 2:** FAIL. **Step 3:** add `visible: !!adj.visible` to the pushed row. **Step 4:** run every engine suite and `invoiceLineItems.test.js`, `payrollMath` tests; update any deep-equal on breakdown rows (adding the key only). PASS. **Step 5: Commit** "feat(pricing): breakdown adjustment rows carry visibility".

### Task P2: Protected lines are not cancel-line targets

**Files:** Modify `server/utils/lineItemCancel.js` (targets L244-251; the adjustment branch of `applyLineItemCancel` about L575); Test: the cancel-line test file.

- [ ] **Step 1: Failing tests:** targets for a booking with an ordinary discount, a `source: 'refund'` line and a `source: 'agreed_price'` line mark the two protected ones `cancellable: false, reason: 'protected_line'`; preview AND execute on a protected index return 409 `PROTECTED_LINE` and write nothing; the ordinary discount still cancels as today.
- [ ] **Step 2:** FAIL. **Step 3:** implement with `isProtectedAdjustment`; the error is `ConflictError('This line records a refund or an agreed price and cannot be removed here.', 'PROTECTED_LINE')`. **Step 4:** PASS (and the existing cancel-line suites). **Step 5: Commit** "feat(cancel-line): refund and agreed-price lines cannot be cancelled".

### Task P3: Admin views tag hidden lines and drop the remove button on protected ones

**Files:** Create `client/src/utils/hiddenRows.js`, `hiddenRows.test.js`; Modify `client/src/components/PricingBreakdown.js` (render at L85-101), `client/src/utils/eventDetailView.js` (`financialsOf` L233-243), `client/src/pages/mobile/EventDetailPhone.js:226` render, `client/src/index.css`.

**Interfaces:** Produces `hiddenRowFlags(snapshot) -> boolean[]` aligned with `snapshot.breakdown`.

- [ ] **Step 1: Failing tests:** (a) rows that carry `visible` use it; (b) an OLD snapshot (no `visible` on rows) matches its adjustment rows in engine order against `snapshot.adjustments` by `adjLabel` and `adjSignedCents`, so a hidden adjustment with no `visible` key is flagged hidden and a visible one is not; (c) non-adjustment rows are never flagged; (d) `PricingBreakdown` shows "hidden from client" on flagged rows and no remove button on a matched target with `reason: 'protected_line'`; (e) `financialsOf` lines carry `hidden: true` for flagged rows and EventDetailPhone renders the tag.
- [ ] **Step 2:** FAIL. **Step 3: Implement**

```js
// client/src/utils/hiddenRows.js
import { adjVisible, adjLabel, adjSignedCents } from './adjustmentRules';
const toCents = (n) => Math.round(Number(n || 0) * 100);
export function hiddenRowFlags(snapshot) {
  const rows = (snapshot && Array.isArray(snapshot.breakdown)) ? snapshot.breakdown : [];
  if (rows.some(r => r && Object.prototype.hasOwnProperty.call(r, 'visible'))) {
    return rows.map(r => !!r && Object.prototype.hasOwnProperty.call(r, 'visible') && !r.visible);
  }
  const adjs = (snapshot && Array.isArray(snapshot.adjustments)) ? snapshot.adjustments : [];
  let k = 0;
  return rows.map((r) => {
    const a = adjs[k];
    if (a && r && r.label === adjLabel(a) && toCents(r.amount) === adjSignedCents(a)) { k += 1; return !adjVisible(a); }
    return false;
  });
}
```

The tag is a small chip reusing the existing `.chip` class with a muted modifier added in the admin block of `index.css`. **Step 4:** PASS. **Step 5: Commit** "feat(admin): hidden lines are tagged; protected lines lose the remove button". **Step 6:** README line for `hiddenRows.js`; walkthroughs-owed "Admin breakdown on desktop and phone shows hidden-from-client tags; refund line has no remove button". Commit.

---

## Lane refund-line

### Task R1: The refund line writer

**Files:** Create `server/utils/refundLine.js`; Test: `server/utils/refundLine.test.js` (DB).

**Interfaces:** Produces `appendRefundLine(dbClient, { proposalId, refundId, contractCents, legalHoldIds = LEGAL_HOLD_PROPOSAL_IDS }) -> Promise<{ written: boolean }>`. Caller holds the proposal row lock inside its transaction.

- [ ] **Step 1: Failing DB tests** (synthetic proposal with a snapshot holding one visible add-on row and a gratuity row):
  1. Appends `{ type: 'discount', label: 'Refund', amount: 285, visible: true, source: 'refund', refund_id: <id> }` to `proposals.adjustments` and to `pricing_snapshot.adjustments`, inserts `{ label: 'Refund', amount: -285, visible: true }` into `breakdown` immediately before the gratuity row (or at the end when there is none), and lowers `pricing_snapshot.total` by 285 floored at 0.
  2. `contractCents <= 0` writes nothing.
  3. A legal-hold id (inject `[proposalId]`) writes nothing.
  4. A second call with the same `refundId` writes nothing (the line is found by `refund_id`).
- [ ] **Step 2:** `node --test server/utils/refundLine.test.js`, FAIL. **Step 3: Implement**: `SELECT adjustments, pricing_snapshot FROM proposals WHERE id = $1`; skip when held, when `contractCents <= 0`, or when a line already has `refund_id === refundId`; build the line; one `UPDATE proposals SET adjustments = $2, pricing_snapshot = $3 WHERE id = $1`. The gratuity row is found with the shared label constants (`gratuityLabels.js` `GRATUITY_LABEL` and the display aliases the engine writes). **Step 4:** PASS. **Step 5: Commit** "feat(refunds): the refund line writer".

### Task R2: Every contract refund writes its line

**Files:** Modify `server/utils/refundHelpers.js` (after the money UPDATE at L596-604; call lines only); Test: a new `server/utils/refundHelpers.line.test.js` (DB), driving `applyRefundReconciliation` with fixture rows (no Stripe).

- [ ] **Step 1: Failing tests:**
  1. A contract-scope refund of $285 writes one Refund line with the refund row's id, syncs the snapshot, and bumps `updated_at`.
  2. Overpayment scope writes no line.
  3. A refund linked to an Additional Services invoice (extra scope) writes no line.
  4. Re-running the same refund (`applied: false`) writes nothing more.
  5. Review Focus 3: a fixture whose `snapshot.total` sits $20 above `total_price` before the refund ends with BOTH lowered by exactly the refund (the $20 drift preserved, neither column re-derived), the line present once. (That the page then adds up to its own Total is C2's invariant, tested there.)
  6. Review Focus 4: two refunds on one booking, one overpayment and one contract: exactly one line, carrying the contract refund's id.
  7. On an override booking (step 1 window) the line is written AND the override is lowered, as today.
- [ ] **Step 2:** FAIL. **Step 3:** after the money UPDATE: `if (contractCents > 0) await appendRefundLine(dbClient, { proposalId, refundId: <the succeeded refund row id from steps 2/3 of the function>, contractCents });`. `refundHelpers.js` must stay under 900 lines. **Step 4:** run the new suite and every existing refund suite one at a time (`refundHelpers.test.js`, `refundExecute*.test.js`, the sweep and webhook refund suites); PASS. **Step 5: Commit** "feat(refunds): a contract refund writes a Refund line so the next save cannot bill it again".
- [ ] **Step 6:** README and ARCHITECTURE (refund section: the line, its markers, the legal-hold skip); `scripts/sensitive-paths.txt` adds `refundLine.js`; `docs/walkthroughs-owed.md`: "A refund on a dev booking writes a visible Refund line and the next editor save bills nothing (dev talks to live Stripe: the smallest real amount on a booking Dallas names, or skip and rely on the suites)". Commit.

---

## Lane invoice-step

### Task I1: The step rule

**Files:** Create `server/utils/invoiceStep.js`, `server/utils/invoiceStep.test.js`.

**Interfaces:** Produces `contractStep({ label, lineTotalsCents, amountDueCents, contractTotalCents }) -> null | { contract_total_cents, step_cents, step_label }`.

- [ ] **Step 1: Failing test**

```js
const { contractStep } = require('./invoiceStep');
test('deposit, balance, full payment', () => {
  const base = { lineTotalsCents: [80000, 20000], contractTotalCents: 100000 };
  assert.deepEqual(contractStep({ ...base, label: 'Deposit', amountDueCents: 10000 }),
    { contract_total_cents: 100000, step_cents: 90000, step_label: 'Balance, billed later' });
  assert.deepEqual(contractStep({ ...base, label: 'Balance', amountDueCents: 90000 }),
    { contract_total_cents: 100000, step_cents: 10000, step_label: 'Less deposit and earlier payments' });
  assert.deepEqual(contractStep({ ...base, label: 'Full Payment', amountDueCents: 95000 }),
    { contract_total_cents: 100000, step_cents: 5000, step_label: 'Less payments already received' });
});
test('no step when the lines are not the current contract, or nothing to explain', () => {
  const base = { lineTotalsCents: [80000, 20000], amountDueCents: 10000 };
  assert.equal(contractStep({ ...base, label: 'Deposit', contractTotalCents: 90000 }), null); // refunded / pre-fold / edited
  assert.equal(contractStep({ ...base, label: 'Balance', contractTotalCents: 100000, amountDueCents: 100000 }), null);
  assert.equal(contractStep({ ...base, label: 'Additional Services', contractTotalCents: 100000 }), null);
  assert.equal(contractStep({ ...base, label: 'Deposit', contractTotalCents: null }), null);
  assert.equal(contractStep({ lineTotalsCents: [], label: 'Deposit', amountDueCents: 0, contractTotalCents: 0 }), null);
});
```

- [ ] **Step 2:** FAIL. **Step 3: Implement**: `LABELS = { Deposit: 'Balance, billed later', Balance: 'Less deposit and earlier payments', 'Full Payment': 'Less payments already received' }`; null unless the label is a key, `contractTotalCents` is a finite number, the line sum equals it exactly, and `sum - amountDueCents > 0`. **Step 4:** PASS. **Step 5: Commit** "feat(invoices): the contract-to-invoice step rule".

### Task I2: The route and the page

**Files:** Modify `server/routes/invoices.js` (base SELECT L31-45; before `res.json` L172-182), `client/src/pages/invoice/InvoicePage.js:362-377`, `client/src/index.css` (screen and the `.invoice-page` print rules about L10541); Tests: an invoice route test and an InvoicePage test.

- [ ] **Step 1: Failing tests.** Route: a synthetic Deposit invoice with lines summing to the proposal's `total_price` returns `contract_step` with the Deposit label; the response contains no `proposal_total_price` key; a refunded locked Deposit (fixture: lines unchanged, `total_price` lowered) returns `contract_step: null`. Page: with `contract_step` it renders "Contract Total", the step row as a negative amount, then "Invoice Total" = `amount_due`, Amount Paid and Balance Due as today; with null it renders exactly today's block.
- [ ] **Step 2:** FAIL. **Step 3: Implement**: select `p.total_price AS proposal_total_price`; compute `contractStep({ label: invoice.label, lineTotalsCents: lineItemsRes.rows.map(r => Number(r.line_total)), amountDueCents: Number(invoice.amount_due), contractTotalCents: Math.round(Number(invoice.proposal_total_price) * 100) })`; `delete invoice.proposal_total_price`; add `contract_step` to the response object. Page: render the three rows when present. Print CSS: confirm the new rows print in the same style (add the selector to the print rule if the rows use a new class). **Step 4:** PASS. **Step 5: Commit** "feat(invoices): Deposit and Balance invoices show the step from the contract to the invoice total".
- [ ] **Step 6:** README, ARCHITECTURE (the `GET /api/invoices/t/:token` row notes `contract_step`), `scripts/sensitive-paths.txt` (`invoiceStep.js`), walkthroughs-owed "Deposit and Balance invoice, screen and Save as PDF". Commit.

---

## Lane fold-holds

### Task F1: The legal-hold guard in the fold and the switch

**Files:** Modify `server/utils/proposalExtrasFold.js` (top of `foldExtrasIntoProposal`, L110), `server/routes/proposals/publicSwitch.js` (the predicate at L177-182); Tests: a fold test and a switch test.

- [ ] **Step 1: Failing tests:** `foldExtrasIntoProposal` with an injected `legalHoldIds` containing the fixture's id throws a `ConflictError` with code `NOT_CHANGEABLE` and message "This booking can't be changed online right now." and writes nothing; the switch route refuses an injected held id with its existing `SWITCH_NOT_AVAILABLE` response (same message as today, never naming the hold). For each production caller (`lineItemCancel.js:613`, `drinkPlans/submit.js:450`, `drinkPlans/lab.js:344`), read the surrounding transaction and record in the test file's header the line that ROLLBACKs on a throw; add one route-level test (cancel-line on a held fixture) proving no row changed.
- [ ] **Step 2:** FAIL. **Step 3:** implement (the list is a defaulted parameter on the exported function's options, the inbox precedent). **Step 4:** PASS, plus every existing fold suite (`proposalExtrasFold.stability.test.js`, `.legs.test.js`, `contractDuration.extension.test.js`) and the switch suites. **Step 5: Commit** "feat(proposals): legal-hold bookings refuse every client-triggered re-price".

### Task F2: The shared catalog compute

**Files:** Modify `server/utils/proposalExtrasFold.js` (extract from L131-205; export at L252); Test: `server/utils/proposalExtrasFold.catalog.test.js` (DB).

**Interfaces:** Produces `computeCatalogSnapshot(client, proposal, { adjustments } = {}) -> Promise<snapshot>`: the engine output for the booking's CURRENT inputs at today's catalog with no override: `SELECT * FROM service_packages WHERE id = $1`; add-ons via `loadRepriceAddons(client, proposal.id)`; syrups from `proposal.pricing_snapshot.syrups.selections` filtered exactly as `submit.js` filters `syrupsBefore` (L292, L430); `numBars = proposal.num_bars ?? 0`; `numBartenders = proposal.num_bartenders`; contract hours via `contractDurationHours`; gratuity rate, tip jar and mandate floor from the row; `adjustments ?? proposal.adjustments ?? []`; `totalPriceOverride: null`.

- [ ] **Step 1: Failing test:** for a native fixture booking, `computeCatalogSnapshot` equals (deep-equal) the snapshot `foldExtrasIntoProposal` writes when called with before == after inputs (no extras change), run inside a transaction that is rolled back; and the fold's native branch now calls the same argument builder (assert by spying, or by a second fixture where both diverge if either drifts).
- [ ] **Step 2:** FAIL. **Step 3:** extract one internal `catalogEngineArgs(...)` used by both the fold's legs and `computeCatalogSnapshot`. No behavior change to the fold. **Step 4:** PASS plus every fold suite. **Step 5: Commit** "refactor(fold): one catalog compute shared with the conversion". ARCHITECTURE line for the export.

---

## Lane conversion-tooling

### Task V1: The export query and the Neon branch helper

**Files:** Create `scripts/override-conversion/export.sql`, `scripts/override-conversion/branch.js`, `scripts/override-conversion/freshCompute.js`.

- [ ] **Step 1:** `export.sql`: one read-only query returning JSON for (a) every proposal with `total_price_override IS NOT NULL`, (b) every proposal with a succeeded contract-scope refund, each with `id, status, total_price, amount_paid, total_price_override, adjustments, pricing_snapshot, updated_at` (as `to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` in UTC), their succeeded refunds (`id, amount, total_scope, total_price_before, total_price_after, created_at`), Additional Services invoices created after each refund (`id, created_at, amount_due`), and pending change requests (`id, created_at`). No names or emails selected.
- [ ] **Step 2:** `branch.js`: creates a branch of prod (`br-noisy-frog-ad99sa6l`, project `round-tooth-34649976`) named `override-conversion-<YYYYMMDD-HHMM>` through the Neon REST API with `NEON_API_KEY` (reuse the request helpers' shape from `scripts/testdb-smoke.js`), waits for it, prints the branch id and writes the connection URI to a file under the session scratchpad (chmod 600), never to stdout. Refuses to run if `ci-smoke` is the target. `--delete <branch-id>` removes it.
- [ ] **Step 3:** `freshCompute.js <uri-file> <ids...>`: opens a `pg` Pool on the branch, and for each id reads the row and calls `computeCatalogSnapshot(client, row)` (F2) with the row's current adjustments, printing JSON `{ id, freshServiceCents, snapshot }` to a scratchpad file. Read-only (it runs inside `BEGIN ... ROLLBACK`).
- [ ] **Step 4: Commit** "feat(scripts): override conversion export query, prod branch helper, fresh compute". (These run only by hand; their tests are V2's fixtures plus a `--help` smoke.)

### Task V2: The transform

**Files:** Create `scripts/override-conversion/transform.js`, `scripts/override-conversion/transform.test.js`.

**Interfaces:** Produces `planConversion({ rows, fresh, legalHoldIds }) -> { changes: Change[], report: ReportRow[], dallasLists: { snapshotMismatch, refundGapZero, refundGapUnequal, pendingChangeRequests } }`, where `Change = { id, kind: 'override_live' | 'override_terminal' | 'refund_backfill', before: { total_price, amount_paid, status, total_price_override, adjustments, pricing_snapshot, updated_at }, after: { adjustments, pricing_snapshot, total_price_override }, lines: Adjustment[] }`.

- [ ] **Step 1: Failing tests** on SYNTHETIC rows, one per shape (spec 8.2-8.4): live override priced from `fresh` (line = override - freshServiceCents; new snapshot = fresh with the line appended; gate total == total_price); terminal override in place (line = override - max(0, subtotal + net), via `adjSignedCents`); existing adjustments (net -237.50 style); 527/599 shape (row override below the snapshot's); an even row (override cleared, no line); refund backfill with two contract refunds (two lines, each with its `refund_id`); a booking whose step-1 refund already has its line (only the older refund backfilled); gap 0 with an unbacked refund (listed, not changed); unequal gap (listed); snapshot/row adjustments mismatch (listed, not changed); a legal-hold id (absent from everything); the 59 shape (untouched); a missing `snapshot.gratuity` (treated as 0). Every change carries `source` markers and passes `validateAdjustments`.
- [ ] **Step 2:** FAIL. **Step 3:** implement (pure; dollars in, cents for every compare). **Step 4:** PASS. **Step 5: Commit** "feat(scripts): override conversion transform".

### Task V3: The DO blocks

**Files:** Create `scripts/override-conversion/doBlock.js`, `scripts/override-conversion/doBlock.test.js` (DB, dev), `scripts/override-conversion/run.js` (CLI: export JSON + fresh JSON in, report + forward + reverse SQL out to the scratchpad).

**Interfaces:** Produces `renderForwardBlock(changes) -> string`, `renderReverseBlock(changes) -> string`.

- [ ] **Step 1: Failing DB tests** on synthetic fixture rows created by the test: (spec section 10) after the forward block converts a LIVE-shape fixture, `foldExtrasIntoProposal` adding one syrup raises `total_price` by exactly that syrup's catalog price and nothing else; the forward block applies every change and inserts one `proposal_activity_log` row per booking (`price_override_converted` / `refund_line_backfilled`; confirm the allowed `actor_type` from `schema.sql` and use the system value); a fixture altered after rendering (one byte of its snapshot changed) makes the block RAISE and leaves EVERY fixture unchanged; a NULL before-value that the block expected non-null RAISEs; the reverse block restores every before-state byte for byte and refuses if a row is not in its after-state.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** One `DO $conv$ ... $conv$` block: `PERFORM 1 FROM proposals WHERE id = ANY(<ids>) FOR UPDATE`; per row, `IF (SELECT ROW(total_price, amount_paid, status, total_price_override, adjustments, pricing_snapshot, date_trunc('microseconds', updated_at)) FROM proposals WHERE id = <id>) IS DISTINCT FROM ROW(<literals>) THEN RAISE EXCEPTION 'before-state changed on %', <id>; END IF;` then the UPDATE, `GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE ...`; JSON literals are dollar-quoted with a tag that the renderer proves absent from the payload; the post-write gate re-reads `pricing_snapshot->>'total'` against `total_price` per row. **Step 4:** PASS, run twice to prove cleanup. **Step 5: Commit** "feat(scripts): guarded forward and reverse DO blocks for the conversion".

### Task V4: The runbook

**Files:** Create `docs/runbooks/override-conversion.md`; README script lines; `scripts/sensitive-paths.txt` adds `scripts/override-conversion/`.

- [ ] Write the steps, in order, each with its command: (1) confirm no push is running and step 1 is live; (2) run `export.sql` through Neon MCP `run_sql` on the prod branch and save the JSON to the scratchpad; (3) `node scripts/override-conversion/branch.js` then `freshCompute.js` for the live ids; (4) `node scripts/override-conversion/run.js` producing the report and both blocks in the scratchpad (never in the repo: they carry free-text labels); (5) Dallas reads the report (per booking: id, status, kind, lines, catalog drift for live rows, page and invoice fold verdicts, pending change requests) and his lists, and settles pending change requests on live rows; (6) on his go, run the forward block through `run_sql`; (7) the confirmation query (no override outside the legal-hold list; `snapshot.total = total_price` on every changed row; every non-hold contract refund has a line or is on his list); (8) keep the branch until he confirms, then `branch.js --delete`. Before step (5), the rendered blocks and the report get their own review pass (one reviewer reading the SQL against the transform's change set; spec section 11). Commit "docs(runbook): the override conversion".

---

## Lane override-removal (push 2; cut only after the step 2 confirmation query is clean)

### Task X1: The engine and the server stop reading the override

**Files:** every server file in spec section 9.

- [ ] **Step 1: Failing tests first:** the engine ignores a `totalPriceOverride` argument (serviceTotal = calculatedTotal); the PATCH refuses any body carrying `total_price_override` with a ValidationError ("field not accepted"); `/calculate` ignores it; `publicToken`'s `options_available` no longer reads the column; `publicOptions` no longer returns `custom_pricing`; `publicSwitch` no longer refuses on the column; the refund money UPDATE no longer touches the column; `changeRequests` and `changeRequestNotifications` no longer read it; `serviceExtensionPricing` no longer selects it (L120).
- [ ] **Step 2:** FAIL. **Step 3:** remove the override from: `pricingEngine.js`; `routes/proposals/crud.js` (destructure, L463-470 bounds, `TOTAL_PRICE_OVERRIDE_MAX`, UPDATE column $16 and its value; the step 1 equal-override acceptance in `patchGuards.js` becomes a refusal); `routes/proposals/metadata.js`; `utils/proposalExtrasFold.js` (the override branch L131-190 and the column in the write; `computeCatalogSnapshot` stays); `utils/refundHelpers.js` (the CASE and its comment); `utils/changeRequests.js`; `utils/changeRequestNotifications.js`; `utils/serviceExtensionPricing.js`; `routes/proposals/publicToken.js`; `routes/proposals/publicOptions.js`; `routes/proposals/publicSwitch.js`; `routes/proposals/optionsPricingShared.js`; `routes/clientPortal.js` and `routes/clientPortal/summary.js` (any remaining reference). **Step 4:** run every touched suite one at a time; PASS. **Step 5: Commit** "feat(pricing): the price override is retired".

### Task X2: The client, the scripts, the schema comment, the docs

- [ ] Client: `proposalEditor/{formState.js, patchBody.js, editorCore.js, ProposalEditorForm.js}` drop every override reference (the step 1 read-only notice included); `pages/public/portal/constants.js`. Delete `scripts/cc-transfer-events.js`, `scripts/cc-transfer-events.test.js`, `scripts/cc-balance-invoice.js` (git rm, with Dallas's per-action yes per the destructive-ops rule). `schema.sql` about L1326: comment the column as retired, holding only legal-hold data. Update the about 23 test files that reference the override. ARCHITECTURE (L355, L378, L379, L412, L1150, L1878, L2084 areas) and README (L752) per spec 9.1. Final check: `grep -rn "total_price_override" server client/src scripts docs *.md` returns only the schema comment, the legal-hold note, history docs and this plan/spec. Commit "chore(pricing): override references removed; CC cutover scripts retired".

---

## Execution

- Lanes are cut as worktrees off current `main` (`npm run worktree:new`), built, reviewed with the full fleet per lane before merge (`scripts/merge-lane.sh`), push 1 after every push-1 lane is merged and the push-time sweep, `/second-opinion` and `npm run gate` pass.
- Parallel: after `adj-rules` merges, `client-rows`, `editor`, `line-protection`, `refund-line` run in parallel; `invoice-step` and `fold-holds` can start at once (no dependency); `conversion-tooling` after `fold-holds`, `refund-line`, `adj-rules`.
- Shared files across parallel lanes (`README.md`, `ARCHITECTURE.md`, `docs/walkthroughs-owed.md`, `scripts/sensitive-paths.txt`, `client/src/index.css`) conflict textually only; resolve at merge, keep both sides.
- Inside a lane: one implementer builds the lane's tasks in order (TDD as written), then the lane's full fleet reviews before merge.
