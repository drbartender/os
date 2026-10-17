---
spec: docs/superpowers/specs/2026-10-16-price-override-removal-design.md   # approved in sections 2026-10-14..16; fleet folded c8b6eb94; plan-fleet amendments folded 2026-10-16
pushes:
  push-1: [adj-rules, client-rows, portal-rows, editor, line-protection, refund-line, invoice-step, fold-holds]   # then the gate-registration commit, then the push
  anytime-before-step-2: [conversion-tooling]   # deploys nothing; may ride push 1 or a later push
  step-2: conversion run on prod (runbook, lane conversion-tooling; Dallas's go on the dry run)
  push-2: [override-removal]
lanes:
  - id: adj-rules
    footprint:
      - server/utils/adjustmentRules.js
      - server/utils/adjustmentRules.test.js
      - client/src/utils/adjustmentRules.js
      - server/utils/legalHold.js
      - server/utils/legalHold.test.js
      - server/utils/lineItemCancel.js
      - server/routes/proposals/cancelLineItem.protected.test.js
      - ARCHITECTURE.md
      - README.md
      - scripts/sensitive-paths.txt
    blockedBy: []
    review: full-fleet   # the one definition of a money line, the hold seam, cancel-line protection
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
      - server/routes/proposals/publicToken*.test.js
      - server/routes/proposals/publicSwitch.test.js
      - server/routes/proposals/publicLeak.test.js
      - server/routes/drinkPlans.js
      - client/src/pages/proposal/proposalView/ProposalView.js
      - client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js
      - client/src/pages/proposal/proposalView/pageRows.js
      - client/src/pages/proposal/proposalView/pageRows.test.js
      - ARCHITECTURE.md
      - README.md
      - docs/walkthroughs-owed.md
      - docs/fix-list-remaining-2026-07-02.md
      - scripts/sensitive-paths.txt
    blockedBy: [adj-rules]
    review: full-fleet   # public payloads and the client's money display
  - id: portal-rows
    footprint:
      - server/routes/clientPortal.js
      - server/routes/clientPortal.test.js
      - server/routes/clientPortal/summary.js
      - server/routes/clientPortal/summary.test.js
      - server/routes/clientPortal/*.test.js
      - server/utils/changeRequestNotifications.js
      - server/utils/changeRequestNotifications*.test.js
      - client/src/pages/public/portal/tabs/PrescriptionTab.js
      - client/src/pages/public/portal/tabs/PrescriptionTab.test.js
      - client/src/pages/public/portal/constants.js
      - ARCHITECTURE.md
      - docs/walkthroughs-owed.md
    blockedBy: [client-rows]
    review: full-fleet   # portal totals now include gratuity; revertable on its own
  - id: editor
    footprint:
      - server/routes/proposals/patchGuards.js
      - server/routes/proposals/patchGuards.test.js
      - server/routes/proposals/crud.js
      - server/routes/proposals/crud*.test.js
      - server/routes/proposals/getOne.js
      - server/utils/contractDuration.extension.test.js
      - client/src/pages/admin/proposalEditor/**
      - client/src/components/mobile/useEditSheet.js
      - client/src/components/mobile/*EditSheet*.js
      - client/src/utils/editSheetView.js
      - client/src/utils/editSheetView.test.js
      - client/src/pages/admin/RemoteStaffingFeePrompt.js
      - client/src/pages/admin/RemoteStaffingFeePrompt.test.js
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
      - client/src/utils/hiddenRows.js
      - client/src/utils/hiddenRows.test.js
      - client/src/components/PricingBreakdown.js
      - client/src/components/PricingBreakdown*.test.js
      - client/src/utils/eventDetailView.js
      - client/src/utils/eventDetailView.test.js
      - client/src/pages/mobile/EventDetailSections.js
      - client/src/pages/mobile/EventDetailPhone.test.js
      - client/src/index.css
      - README.md
      - docs/walkthroughs-owed.md
    blockedBy: [adj-rules]
    review: full-fleet   # the engine and the admin money display
  - id: refund-line
    footprint:
      - server/utils/refundLine.js
      - server/utils/refundLine.test.js
      - server/utils/refundHelpers.js
      - server/utils/refundHelpers.line.test.js
      - ARCHITECTURE.md
      - README.md
      - docs/walkthroughs-owed.md
      - docs/fix-list-remaining-2026-07-02.md
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
    blockedBy: []
    review: full-fleet   # public invoice route
  - id: fold-holds
    footprint:
      - server/utils/proposalExtrasFold.js
      - server/utils/proposalExtrasFold*.test.js
      - server/routes/proposals/publicSwitch.js
      - server/routes/proposals/publicSwitch.legalHold.test.js
      - server/routes/proposals/cancelLineItem.legalHold.test.js
      - ARCHITECTURE.md
    blockedBy: [adj-rules]
    review: full-fleet   # the client-triggered re-pricing writer
  - id: conversion-tooling
    footprint:
      - scripts/override-conversion/**
      - docs/runbooks/override-conversion.md
      - README.md
      - scripts/sensitive-paths.txt
    blockedBy: [adj-rules, client-rows, fold-holds, refund-line]
    review: full-fleet   # produces the prod write; the rendered SQL also gets database-review + consistency-check before it runs
  - id: override-removal
    footprint:
      - server/utils/pricingEngine.js
      - server/routes/proposals/crud.js
      - server/routes/proposals/patchGuards.js
      - server/routes/proposals/metadata.js
      - server/utils/proposalExtrasFold.js
      - server/utils/refundHelpers.js
      - server/utils/changeRequests.js
      - server/utils/changeRequestNotifications.js
      - server/utils/serviceExtensionPricing.js
      - server/utils/invoiceLineItems.js
      - server/routes/proposals/publicToken.js
      - server/routes/proposals/publicOptions.js
      - server/routes/proposals/publicSwitch.js
      - server/routes/proposals/optionsPricingShared.js
      - server/routes/clientPortal.js
      - server/routes/clientPortal/summary.js
      - server/db/schema.sql
      - server/**/*.test.js
      - client/src/pages/admin/proposalEditor/**
      - client/src/pages/public/portal/constants.js
      - client/src/**/*.test.js
      - scripts/cc-transfer-events.js
      - scripts/cc-transfer-events.test.js
      - scripts/cc-balance-invoice.js
      - scripts/money-smoke-list.txt
      - ARCHITECTURE.md
      - README.md
      - docs/fix-list-remaining-2026-07-02.md
    blockedBy: [client-rows, portal-rows, editor, line-protection, refund-line, invoice-step, fold-holds, conversion-tooling, STEP-2-CONFIRMED]
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
- DB test files start with `require('dotenv').config()` (`invoiceLineItems.test.js:8`); bare `node --test` relies on it.
- `proposals` has `admin_notes`, not `notes` (`schema.sql:884`); `pricing_snapshot` is `NOT NULL DEFAULT '{}'` (`schema.sql:874`), so refund suites run against `{}` snapshots. The engine stamps `calculated_at: new Date().toISOString()` into every snapshot (`pricingEngine.js:585`).
- Breakdown order: the engine pushes `SHARED_GRATUITY_LABEL` rows inside staffing and the additional-bartender add-on (about L523-529, L550-555), then the adjustment rows (L574-580), then the client `GRATUITY_LABEL` row LAST and only when it is above zero (L581-583).
- Every public page view runs `UPDATE proposals SET view_count ...` (`publicToken.js:336-341`), which moves `updated_at` through the trigger. A staleness check on `updated_at` would refuse editors after any client view; the plan's check keys on the stored lines instead (decision 8).
- `server/utils/contractDuration.extension.test.js` PATCHes with a full editor body including `adjustments` (`editorBody` L141; requests L265-319) and is on `scripts/money-smoke-list.txt` (L150).
- Phone: `useEditSheet.js:73` calls `editLockedReason` from `client/src/utils/editSheetView.js` (with `saveErrorText`); the phone financial lines render in `client/src/pages/mobile/EventDetailSections.js:95-100` (`fin.lines.map`); `EventDetailPhone.js:226` only computes `fin`; its test is `EventDetailPhone.test.js`. Both editor parents close the editor and refetch on save (`ProposalDetail.js:515-519`, `EventDetailPage.js:358-359`).
- Cancel-line's route harness is `server/routes/proposals/cancelLineItem.test.js:218-232`; `crud.js:36` has the `__setDeps` seam; `publicSwitch.js` has none.
- `proposal_activity_log` has no CHECK constraints (`schema.sql:935-943`; `action VARCHAR(50)`, `actor_type VARCHAR(20) DEFAULT 'system'`).
- `scripts/sensitive-match.js` anchors patterns `^...$` and `*` never crosses `/`: a folder needs `dir/*`, never a bare `dir/`. `scripts/money-smoke-list.txt` (136 entries, sensitive-listed) is the only suite list `npm run gate` runs.
- `scripts/testdb-smoke.js` only RESETS an existing branch (L150-164) and fetches its URI (L166-180); creating a branch needs `endpoints: [{ type: 'read_write' }]` in the create request. The gate's own branch is `br-twilight-surf-adf8eghx`. `server/db/index.js` binds its pool at load, so a script pointing the server modules at another database sets `DATABASE_URL` before the first `require` (testdb-smoke spawns a child for this, L206-218).
- Prod census of stored adjustments (Neon MCP, read-only, 2026-10-16): 72 lines, every one `type` discount or surcharge, `amount` a numeric string (58) or number (14), none negative or blank, `visible` boolean, `label` a string of at most 255, keys exactly `amount, label, type, visible`. The editor's own "+ Discount" seeds `amount: ''` (`ProposalEditorForm.js:299`), which the engine reads as 0.


## Plan decisions

1. **Ten lanes, two pushes.** Push 1 is every runtime lane (`adj-rules`, `client-rows`, `portal-rows`, `editor`, `line-protection`, `refund-line`, `invoice-step`, `fold-holds`), then one gate-registration commit, then the push. `conversion-tooling` deploys nothing and only has to be merged before step 2. Push 2 is `override-removal`, cut only after step 2's confirmation query is clean.
2. **Each lane is safe alone on main.** Another window may push between merges, so no lane may depend on a later merge for safety. That is why cancel-line's refusal to remove a protected line ships in `adj-rules` (Task A3), before any lane can write a `source` line.
3. **New logic lives in new files** where the touched file is near the cap: `patchGuards.js` beside `crud.js` (958), `refundLine.js` beside `refundHelpers.js` (877), the builder replacing the memo in `ProposalView.js` (913). `crud.js` gains call lines only and stays under 1000.
4. **Client-facing refusals never say "legal hold".** Public and client-triggered paths (switch, drink-plan submit, Lab) answer "This booking can't be changed online right now."; only admin surfaces name the hold.
5. **Invoice copy casing follows the page** ("Contract Total", "Invoice Total"); the three step labels keep the spec's wording. This adjusts approved copy and is put to Dallas with the plan.
6. **The public fold never sends its gap**: the gap is the hidden net; only the rows leave the server.
7. **The legal-hold seam is one module**, `server/utils/legalHold.js` (`isLegalHold(id)`, coercing with `Number`), with a test-only setter that refuses under `NODE_ENV=production`. Every guard calls it; no test touches id 600.
8. **The staleness check keys on the stored LINES, not `updated_at`.** A client page view bumps `updated_at`, so an `updated_at` check would refuse editors at random. The admin GET and the PATCH response carry `adjustments_token = md5(COALESCE(adjustments, '[]'::jsonb)::text)`. A PATCH whose `adjustments` differ from the stored ones (compared canonically) must carry the current token, else 409 `STALE_EDIT`. A body that leaves the lines unchanged needs no token (so `contractDuration.extension.test.js`, the phone sheet and partial PATCHes keep working), and a tab that saw old lines can never write over new ones (refund lines, conversion lines). Spec 5.1 is amended to match.
9. **Blank amounts count as 0.** The editor seeds `amount: ''`; the validator coerces blank, null and undefined to 0 the engine's way and does not round. Everything else stays strict (the prod census shows no stored line it would refuse).
10. **The conversion's data never passes through this chat.** The export runs over `pg` against a fresh Neon branch of prod; the forward block is compact (md5 guards, jsonb operations for in-place rows, full literals only for the four live snapshots) and asserts its own arithmetic before committing. Spec 8.5 is amended to match.
11. **The sanitizer is a denylist that replaces the package price.** It deletes `subtotal`, `breakdown`, `total_price_override` and hidden adjustments, and sets `package.base_cost` so `base_cost + staffing.total` equals the folded package row. A browser still running the old bundle during the deploy then draws folded rows that add up. A new bundle against the old server (no `price_rows`) shows the Total only for the minutes until Render finishes, which is accepted.
12. **New money suites join the gate in one commit** after the last push-1 lane merges (and again for push 2), so parallel lanes never collide on the sensitive-listed `scripts/money-smoke-list.txt`.

## Global Constraints

- No em dashes anywhere (copy, comments, commits, docs). No client PII in fixtures, docs or commits: synthetic labels ("Test discount A"), synthetic amounts, ids only.
- Money compares in integer cents (`Math.round(Number(x) * 100)`); `proposals.total_price` and adjustment amounts are DOLLARS; `invoice_line_items.line_total` and `invoices.amount_due` are CENTS; `proposal_refunds.amount` is CENTS.
- Raw parameterized SQL only; handlers `asyncHandler`; client-visible errors are `AppError` subclasses (`ValidationError`, `ConflictError`) from `server/utils/errors.js`.
- One pooled connection per request: a handler holding `pool.connect()` uses that client for every query until release.
- File-size ratchet: no touched file may cross 1000 lines in a growing commit (`node scripts/check-file-size.js --staged`).
- Explicit `git add <path>` only; commit messages via `-F` heredoc, no backticks; trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and the session line.
- Proposal 600 is never written by any test, script or block in this plan. Tests inject legal-hold ids through `__setLegalHoldIdsForTest`; nothing uses id 600.
- Dev talks to live Stripe: no test in this plan creates a real refund; refund tests drive `applyRefundReconciliation` directly with fixture rows.
- Every new server module under `server/utils/` or `server/routes/` gets its README tree line and an ARCHITECTURE mention in the same lane; every new money file gets a `scripts/sensitive-paths.txt` line (confirm with `node scripts/sensitive-match.js <path>`).

## Review Focus

1. **An editor opened from a stale proposal.** Both parents close the editor and refetch after a save; reopening before the refetch resolves seeds old lines and an old token. That save must be refused (409 `STALE_EDIT`, Reload), never clobber the stored lines. Test owned by Task E4.
2. **A gratuity election re-quote on a hidden-discount booking.** After `applyIntentQuote` rewrites `snapshot.total` and `snapshot.gratuity`, the server rows plus the re-quoted gratuity row still equal the shown Total. Test owned by Task C5.
3. **A refund on a booking whose snapshot already drifted from `total_price`** (the 59 shape). The line is written once and both totals drop by exactly the refund. Test owned by Task R2.
4. **One overpayment-scope and one contract-scope refund on one booking.** Only the contract refund writes a line, and the backfill leaves the overpayment refund alone. Tests owned by Tasks R2 and V2.
5. **A client views the page while Dallas edits.** The view bumps `updated_at`; the editor's save must still succeed (the token keys on the lines). Test owned by Task E2.

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
    { type: 'discount', label: 'Test A', amount: '100.25', visible: 0, extra: 'drop me' },
    { type: 'discount', label: '', amount: '', visible: true },                // the editor's fresh line
    { type: 'surcharge', label: '', amount: 5, visible: true, source: 'agreed_price' },
    { type: 'discount', label: 'Refund', amount: 20, visible: true, source: 'refund', refund_id: 14 },
  ]);
  assert.equal(error, null);
  assert.deepEqual(value, [
    { type: 'discount', label: 'Test A', amount: 100.25, visible: false },
    { type: 'discount', label: '', amount: 0, visible: true },
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
    // Blank, null and undefined count as 0, the engine's reading (decision 9); no rounding.
    const raw = adj.amount;
    const n = raw === '' || raw === null || raw === undefined ? 0
      : (typeof raw === 'string' ? (raw.trim() === '' ? 0 : Number(raw)) : raw);
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n >= MAX_ADJUSTMENT_DOLLARS) {
      return fail('A price adjustment amount must be $0 or more and under $1,000,000.');
    }
    const line = { type: adj.type, label, amount: n, visible: !!adj.visible };
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
Expected: PASS, 5 tests. Read the pass count. (A2 adds to this file.)

- [ ] **Step 6: Docs and sensitive list.** README tree lines for both files; one ARCHITECTURE paragraph (pricing section: "adjustment lines, their `source`/`refund_id` markers, and the validation bound"); add both paths to `scripts/sensitive-paths.txt`, confirm with `node scripts/sensitive-match.js server/utils/adjustmentRules.js`.

- [ ] **Step 7: Commit** `git add server/utils/adjustmentRules.js server/utils/adjustmentRules.test.js client/src/utils/adjustmentRules.js README.md ARCHITECTURE.md scripts/sensitive-paths.txt` with message "feat(pricing): one definition of an adjustment line, with markers and validation".

---

### Task A2: The legal-hold seam and the breakdown placement rule

**Files:** Create `server/utils/legalHold.js`, `server/utils/legalHold.test.js`; Modify `server/utils/adjustmentRules.js` and its test.

**Interfaces:**
- `legalHold.js`: `isLegalHold(id) -> boolean` (`Number(id)` against the current list; default `LEGAL_HOLD_PROPOSAL_IDS`), `__setLegalHoldIdsForTest(ids | null)` (throws when `NODE_ENV === 'production'`; `null` restores the default).
- `adjustmentRules.js` adds `insertAdjustmentBreakdownRow(snapshot, row) -> breakdown[]` (a new array): when the snapshot's last breakdown row has label `GRATUITY_LABEL` (from `server/utils/gratuityLabels.js`) AND `Number(snapshot.gratuity && snapshot.gratuity.total) > 0`, the row goes immediately before it; otherwise it is appended. A missing breakdown yields `[row]`.

- [ ] **Step 1: Failing tests.** `isLegalHold(600)` and `isLegalHold('600')` are true by default; after `__setLegalHoldIdsForTest([999999])`, `isLegalHold('999999')` is true and 600 false; `null` restores; the setter throws under a temporarily set `NODE_ENV=production` (restore it in `finally`). Placement: a fixture breakdown `[package, 'Shared Gratuity' (staffing), addon, 'Shared Gratuity' (addon), adjustment, GRATUITY_LABEL]` with `gratuity.total = 40` gets the new row at index 5 (before the client gratuity row); the same with `gratuity.total = 0` and no client row appends; an admin adjustment labeled "Gratuity" that is NOT last is never treated as the client row; `{}` yields `[row]`.
- [ ] **Step 2:** run both files, FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5: Commit** "feat(pricing): the legal-hold seam and where a written line sits in the breakdown".

### Task A3: Cancel-line cannot remove a protected line

**Files:** Modify `server/utils/lineItemCancel.js` (targets L244-251; the adjustment branch of `applyLineItemCancel` about L575); Create `server/routes/proposals/cancelLineItem.protected.test.js` (copy the harness from `cancelLineItem.test.js:218-232`); ARCHITECTURE (the cancel-line route notes 409 `PROTECTED_LINE`).

- [ ] **Step 1: Failing tests:** for a synthetic booking with an ordinary discount, a `source: 'refund'` line and a `source: 'agreed_price'` line, the targets mark the two protected ones `cancellable: false, reason: 'protected_line'`; preview AND execute on a protected index return 409 `PROTECTED_LINE` and change nothing (re-read the row); the ordinary discount still previews and cancels as today.
- [ ] **Step 2:** FAIL. **Step 3:** implement with `isProtectedAdjustment`; `ConflictError('This line records a refund or an agreed price and cannot be removed here.', 'PROTECTED_LINE')`. **Step 4:** PASS, plus `cancelLineItem.test.js` and `lineItemCancel*.test.js` one at a time (unchanged). **Step 5: Commit** "feat(cancel-line): refund and agreed-price lines cannot be cancelled". This ships before any lane can write such a line (decision 2); the admin remove button is dropped for them in Task P3.

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
- Produces: `buildClientPriceRows(snapshot, { targetCents, packageName }) -> { rows: Array<{ key: string, label: string, amount: number /* dollars */ }>, fold: { applied: 'no_total' | 'none' | 'skipped' | 'package' | 'fallback', gapCents: number, hiddenNetCents: number, unexplainedCents: number } }`. Rows are SERVICE rows only (no gratuity).

- [ ] **Step 1: Characterize today's page rows.** Before writing the builder, copy the body of `ProposalView.js`'s `lineItems` memo (L580-620) into the test file as a local function `legacyRows(snap, packageName)` that returns the same rows minus the gratuity row (L612-617), and freeze three synthetic snapshots as fixtures: (a) flat package with bar rental, two add-ons (one $0), syrups, one visible discount; (b) hosted package with staffing; (c) no adjustments. The builder must reproduce `legacyRows` exactly (same keys, labels, dollar amounts, order) whenever the snapshot has no hidden adjustment.
- [ ] **Step 2: Failing tests**

```js
// server/utils/clientPriceLines.test.js (excerpt; legacyRows and FIXTURES from Step 1 above it)
const cents = (rows) => rows.reduce((s, r) => s + Math.round(r.amount * 100), 0);

test('no hidden lines: identical to the page today', () => {
  for (const snap of FIXTURES) {
    const target = Math.round((snap.total - (snap.gratuity?.total || 0)) * 100);
    const { rows, fold } = buildClientPriceRows(snap, { targetCents: target, packageName: 'Test Package' });
    assert.deepEqual(rows.map(({ key, ...r }) => r), legacyRows(snap, 'Test Package')); // the memo rows carry no key
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
    return { rows: [], fold: { applied: 'no_total', gapCents: 0, hiddenNetCents: 0, unexplainedCents: 0 } };
  }
  const rows = itemizedRows(snapshot, packageName);
  const gapCents = targetCents - rows.reduce((s, r) => s + Math.round(r.amount * 100), 0);
  const pkg = rows.find(r => r.key === 'package');
  const applied = decideFold({ hasPackage: !!pkg, packageCents: pkg ? Math.round(pkg.amount * 100) : 0, gapCents });
  if (applied === 'package') pkg.amount = (Math.round(pkg.amount * 100) + gapCents) / 100;
  if (applied === 'fallback') rows.push({ key: 'pricing-adjustment', label: 'Pricing adjustment', amount: gapCents / 100 });
  const hiddenNetCents = (snapshot.adjustments || []).filter(a => !adjVisible(a)).reduce((s, a) => s + adjSignedCents(a), 0);
  return { rows, fold: { applied, gapCents, hiddenNetCents, unexplainedCents: gapCents - hiddenNetCents } };
}
```

- [ ] **Step 5:** run the test file; expect PASS (5 tests). Read the count.
- [ ] **Step 6: Commit** "feat(pricing): server builder for the rows a client sees, hidden lines folded".

### Task C3: The public snapshot sanitizer

**Files:** Create `server/utils/publicSnapshot.js`, `server/utils/publicSnapshot.test.js`.

**Interfaces:** Produces `sanitizeSnapshotForPublic(snapshot, { packageRowAmount }) -> object | null` (a DENYLIST, decision 11).

- [ ] **Step 1: Confirm the denylist is safe.** Grep every public reader with `grep -rniE "snapshot\??\.|snap\??\.|pricing_snapshot" client/src/pages/proposal client/src/pages/plan client/src/pages/public client/src/components client/src/utils | grep -v test` (it must catch optional chaining and camelCase reads: `floor_reason` at `ProposalPricingBreakdown.js:122,127`, `staffing.actual` and `inputs.durationHours` at `ProposalView.js:663-664`, `bar_rental` in the drink-plan steps `LogisticsStep.js:81` and `ConfirmationStep.js:155-181`, `display_labels` through `client/src/utils/gratuityLabels.js:11`). Record in the module header every reader of a field the sanitizer removes or rewrites (`subtotal`, `breakdown`, `total_price_override`, hidden adjustments, `package.base_cost`). After Task C5, only the old memo read `package.base_cost` and `adjustments` (`ProposalView.js:584, 604`); if anything else reads a removed field, stop and bring it to Dallas.
- [ ] **Step 2: Failing test**

```js
test('hidden data never survives; the package row is folded', () => {
  const snap = { total: 300, subtotal: 400, total_price_override: 300,
    package: { name: 'Test Package', base_cost: 350 }, staffing: { total: 50, actual: 1 },
    adjustments: [{ type: 'discount', label: 'Test secret', amount: 100, visible: false },
                  { type: 'surcharge', label: 'Test shown', amount: 5, visible: true }],
    breakdown: [{ label: 'Test secret', amount: -100 }], gratuity: { total: 0 }, display_labels: { gratuity: 'Tip' } };
  const out = sanitizeSnapshotForPublic(snap, { packageRowAmount: 295 });
  const json = JSON.stringify(out);
  assert.ok(!json.includes('Test secret'));
  assert.ok(!('subtotal' in out) && !('breakdown' in out) && !('total_price_override' in out));
  assert.deepEqual(out.adjustments.map(a => a.label), ['Test shown']);
  assert.equal(out.package.base_cost + out.staffing.total, 295);   // the old bundle draws the folded row
  assert.deepEqual(out.display_labels, { gratuity: 'Tip' });       // denylist keeps everything else
  assert.equal(snap.adjustments.length, 2);                         // input not mutated
});
test('no package row: base_cost removed, nothing invented', () => {
  const out = sanitizeSnapshotForPublic({ total: 10, package: { base_cost: 10 } }, { packageRowAmount: undefined });
  assert.ok(!('base_cost' in out.package));
});
test('null in, null out', () => assert.equal(sanitizeSnapshotForPublic(null, {}), null));
```

- [ ] **Step 3:** FAIL. **Step 4:** implement with `structuredClone`, `adjVisible`, and `base_cost = round2(packageRowAmount - Number(staffing.total || 0))` when `packageRowAmount` is a finite number. **Step 5:** PASS. **Step 6: Commit** "feat(pricing): sanitized public copy of a pricing snapshot".

### Task C4: Public routes send rows and the sanitized snapshot

**Files:** Modify `server/routes/proposals/publicToken.js` (inside `buildPublicProposalPayload`, after L250-262), `server/routes/drinkPlans.js` (the `GET /t/:token` response around L52), `server/utils/clientPriceLines.js` (fold report fields); Create `server/routes/proposals/publicLeak.test.js`; edit `publicToken*.test.js` and `publicSwitch.test.js` only where an assertion read a removed field.

**Interfaces:** the public proposal payload (and so the switch response, `publicSwitch.js:598`) gains `price_rows: Array<{ key, label, amount }>`; `buildClientPriceRows`'s `fold` gains `hiddenNetCents` (sum of `adjSignedCents` over hidden adjustments) and `unexplainedCents = gapCents - hiddenNetCents`.

- [ ] **Step 1: Failing leak test** (route harness as in `crud.test.js`): fixtures (a) a `sent` proposal whose snapshot has a hidden discount `{ label: 'Test leak label', amount: 123.45 }` and `subtotal` 777.77; (b) a `viewed` proposal with `total_price_override` set (row and snapshot); (c) a switchable fixture (status `sent`, no override, unsigned, unpaid, two comparable packages) with a hidden discount, and a drink plan row on (a). Assert, on `GET /api/proposals/t/:token` for (a) and (b), on the switch response for (c), and on `GET /api/drink-plans/t/:token` for (a): the serialized body contains none of `'Test leak label'`, `'123.45'`, `'777.77'`, and no `total_price_override` key at any depth; `price_rows` sums (cents) to `snapshot.total - snapshot.gratuity.total`.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** In `buildPublicProposalPayload`: compute `targetCents` from the stored snapshot, `const { rows, fold } = buildClientPriceRows(snap, { targetCents, packageName: proposal.package_name })`, set `publicProposal.price_rows = rows` and `publicProposal.pricing_snapshot = sanitizeSnapshotForPublic(snap, { packageRowAmount: rows.find(r => r.key === 'package')?.amount })`. Report to Sentry (proposal id only, no amounts; at most once per proposal per process via a module-level `Set`, mirroring `reportFold`, `invoiceLineItems.js:216-242`) when `fold.applied` is `'fallback'` or `'skipped'`, or when `snap.total_price_override` is null and `Math.abs(fold.unexplainedCents) > rows.length`. `drinkPlans.js` sends `sanitizeSnapshotForPublic(row.pricing_snapshot, { packageRowAmount: <same builder call> })`. Record in the test file's header the public-route sweep (`grep -rn "pricing_snapshot\|adjustments" server/routes | grep -v test`): the Lab's `lab_breakdown` prices only Lab additions (`lab.js:111-115`) and `public.js:96` is the catalog calculator spec 4.3 accepts; nothing else returns a snapshot to a token holder.
- [ ] **Step 4:** run the leak test, then `publicToken*.test.js` and `publicSwitch.test.js` one at a time; PASS. **Step 5: Commit** "feat(proposals): public payloads carry folded rows and no hidden data".

### Task C5: The proposal page renders server rows

**Files:** Create `client/src/pages/proposal/proposalView/pageRows.js`, `pageRows.test.js`; Modify `ProposalView.js` (replace the memo L580-620), `ProposalPricingBreakdown.js` (only if it reads a row field by another name).

**Interfaces:** `pageRows(priceRows, snapshot) -> rows` (the server rows, or `[]` when absent, followed by today's gratuity row built from `snapshot.gratuity` exactly as L612-617 builds it).

- [ ] **Step 1: Failing test** (no full-page harness exists; the folder tests pure modules, e.g. `intentQuote.test.js`): `pageRows([{ key: 'package', label: 'Test Package', amount: 250 }, { key: 'addon-1', label: 'Test Add-on', amount: 50 }], { total: 300, gratuity: { total: 0 } })` returns those two rows; Review Focus 2: apply `applyIntentQuote` to a snapshot so `gratuity.total` becomes 40 and `total` 340, then `pageRows` returns the two rows plus a Gratuity row of 40, summing to 340; `pageRows(undefined, snap)` returns only the gratuity row (the deploy-skew case, decision 11).
- [ ] **Step 2:** FAIL (`--testPathPattern=pageRows`). **Step 3:** implement; `ProposalView`'s memo becomes `useMemo(() => pageRows(proposal.price_rows, snapshot), [...])`; delete the rest of the old memo. **Step 4:** PASS; `ProposalView.js` must shrink. **Step 5: Commit** "feat(proposal page): render the server's folded rows".

### Task C7: Docs, sensitive list, walkthroughs, fix list

- [ ] README tree lines for `foldDecision.js`, `clientPriceLines.js`, `publicSnapshot.js`, `pageRows.js`; ARCHITECTURE: the public proposal payload and `GET /api/drink-plans/t/:token` rows note `price_rows` and the sanitized snapshot. `scripts/sensitive-paths.txt` adds the three server utils and `server/routes/drinkPlans.js` (confirm each with `node scripts/sensitive-match.js <path>`). `docs/walkthroughs-owed.md`: "Proposal page with a hidden discount: rows add up; view-source and the network tab show no hidden label". Fix list: the public-payload leak entry gets "Built in lane client-rows (<merge sha>)". Commit "docs(pricing): client rows, sanitized payloads".

---

## Lane portal-rows

### Task Q1: Portal rows, totals, and the approved email

**Files:** Modify `server/routes/clientPortal.js` (detail route L102-170; archive L84), `server/routes/clientPortal/summary.js:19-20`, `client/src/pages/public/portal/constants.js:15`, `client/src/pages/public/portal/tabs/PrescriptionTab.js:65-70`, `server/utils/changeRequestNotifications.js:45`; Tests: the portal route test, `server/routes/clientPortal/summary.test.js` (its "override wins" case at L10-14 becomes "total_price wins"), `PrescriptionTab.test.js`.

- [ ] **Step 1: Failing tests.** Route: the portal detail for a synthetic proposal with a hidden discount returns `price_rows` summing (cents) to `total_price - gratuity`, a `gratuity_amount`, and NO `pricing_snapshot`, `adjustments` or `total_price_override` key at any depth. `shapeFocus` returns `total_price` for a row with an override AND a gratuity. PrescriptionTab renders the rows, a Gratuity row when `gratuity_amount > 0`, and Total from `focus.total_price`; rows plus gratuity equal Total.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** Detail route: drop `p.total_price_override` from the column list (L117); read the snapshot in a SEPARATE query (`SELECT pricing_snapshot FROM proposals WHERE id = $1`) so the spread at L167-169 can never carry it; build rows with `targetCents = round((total_price - gratuity.total) * 100)`; respond with `price_rows` and `gratuity_amount`; Sentry-report a fallback, a skip, or an unexplained gap as C4 does (this target is `total_price`, where drift shows). `shapeFocus` and `constants.js` read `total_price` only; the archive SQL drops its `COALESCE`; `changeRequestNotifications.js:45` passes `total_price`. PrescriptionTab renders `p.price_rows` then the gratuity row in place of the add-ons list. **Step 4:** PASS, plus the other portal suites one at a time. **Step 5: Commit** "feat(portal): the Prescription tab shows folded rows that add up; totals read total_price".
- [ ] **Step 6:** ARCHITECTURE (the portal detail route notes `price_rows`, `gratuity_amount`, no snapshot); walkthroughs-owed "Portal Prescription tab for a booking with a hidden discount and a gratuity". Commit.

---

## Lane editor

### Task E1: The PATCH guards module

**Files:** Create `server/routes/proposals/patchGuards.js`, `server/routes/proposals/patchGuards.test.js`.

**Interfaces:**
- Consumes: `validateAdjustments` (A1), `isLegalHold` (A2).
- Produces:
  - `assertNotLegalHold(proposalId)` throws `ConflictError('This booking is on legal hold and cannot be edited.', 'LEGAL_HOLD')` when `isLegalHold(proposalId)` (string ids included).
  - `canonicalLines(adjustments) -> string`: a stable string of the lines after the validator's coercions (keys sorted, `amount` as a Number, `visible` boolean); used to tell whether a body changes the stored lines.
  - `assertLinesFresh(body, oldRow, currentToken)` throws `ConflictError('This booking changed since you opened it. Reload to see the latest.', 'STALE_EDIT')` when `body.adjustments !== undefined`, `canonicalLines(body.adjustments) !== canonicalLines(oldRow.adjustments || [])`, and `body.adjustments_token !== currentToken` (decision 8).
  - `assertOverrideUnchanged(body, oldRow)` throws `ValidationError({ total_price_override: 'Price overrides are retired. Use Set agreed price.' })` when `body.total_price_override` is non-null and either the stored value is null or the two differ in cents (stored arrives as the string "3373.00"; the body may send a Number or a string; a stored NULL against a body `0` DIFFERS).
  - `normalizeAdjustmentsOrThrow(adjustments)` returns the validated array or throws `ValidationError({ adjustments: error })`; `undefined` passes through.

- [ ] **Step 1: Failing tests:** legal hold refused for an injected `'999999'` (string) and `999999`, allowed otherwise; lines fresh: an unchanged body passes with no token; a changed body passes with the current token and is refused with an old or missing token; `canonicalLines` treats `'100'` and `100`, and key order, as equal; override: `3373` vs stored `'3373.00'` passes, `'3373.00'` vs `'3373.00'` passes, `3373.01` refused, body `0` vs stored `null` refused, `null` (clear) and absent pass; adjustments normalized (blank amount becomes 0) and a bad one refused naming the field.
- [ ] **Step 2:** `node --test server/routes/proposals/patchGuards.test.js`, FAIL. **Step 3:** implement (pure). **Step 4:** PASS. **Step 5: Commit** "feat(proposals): PATCH guards for stale lines, legal hold, retired overrides, line validation".

### Task E2: Wire the guards into the PATCH; the token; the audit; the GET flag

**Files:** Modify `server/routes/proposals/crud.js`, `server/routes/proposals/getOne.js`; Test: a new `server/routes/proposals/crud.guards.test.js` (the `crud.test.js` harness), and re-run `server/utils/contractDuration.extension.test.js`.

- [ ] **Step 1: Failing route tests** (synthetic fixtures; legal hold injected through `__setLegalHoldIdsForTest`, reset in `after`):
  1. A PATCH that changes `adjustments` with the token from the GET saves; the response carries the new `adjustments_token`.
  2. The same change with an old token returns 409 `STALE_EDIT` and changes nothing.
  3. A direct `UPDATE proposals SET adjustments = adjustments || '[{"type":"discount","label":"Test server line","amount":5,"visible":true}]'::jsonb WHERE id = $1` refuses the tab's next line-changing save; a direct `UPDATE proposals SET view_count = view_count + 1 WHERE id = $1` (a client page view, Review Focus 5) does NOT.
  4. A body whose `adjustments` equal the stored lines saves with no token (the shape `contractDuration.extension.test.js` sends).
  5. A legal-hold id returns 409 `LEGAL_HOLD` before any write, including a body with `change_request_id` (approval runs inside this PATCH, `crud.js:711-727`).
  6. A changed override returns 400 on `total_price_override`; an equal one saves.
  7. A bad adjustment returns 400 on `adjustments`.
  8. The activity entry for a save that changed the lines carries `old_adjustments` and `new_adjustments`.
  9. Regression for the original bug: a booking with a hidden agreed-price discount and no override; adding one hour raises `total_price` by exactly that hour's catalog price.
- [ ] **Step 2:** FAIL. **Step 3: Implement** with call lines only: `assertNotLegalHold(req.params.id)` before the transaction; read the token in the `FOR UPDATE` select (L359): `md5(COALESCE(adjustments, '[]'::jsonb)::text) AS adjustments_token`; then `assertLinesFresh(req.body, old, old.adjustments_token)` and `assertOverrideUnchanged(req.body, old)`; L421 becomes `const adj = normalizeAdjustmentsOrThrow(adjustments) ?? (old.adjustments || []);`; the activity details at L670-671 add both arrays when `canonicalLines` differ; the `res.json` at L917 carries the new `adjustments_token` (one `md5(...)` in the post-write read, or computed from the written JSON through `pg`'s `md5` in the RETURNING). `getOne.js` adds `legal_hold: isLegalHold(p.id)` and `adjustments_token` (same SQL expression) to its response. `wc -l crud.js` stays under 1000.
- [ ] **Step 4:** run the new suite, then `crud.test.js`, the other `crud*.test.js`, and `contractDuration.extension.test.js` one at a time; all PASS (that suite is on the money gate). **Step 5: Commit** "feat(proposals): the editor PATCH refuses stale lines, legal holds and new overrides".

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
test('the replaced line takes the standard label back', () => {
  const renamed = { ...AP(162), label: 'Test renamed' };
  const r = applyAgreedPrice({ adjustments: [renamed], previewServiceCents: 149300, agreedCents: 140000 });
  expect(r.adjustments[0].label).toBe('Agreed price adjustment');
});
test('refuses to guess across the zero clamp', () => {
  for (const line of [AP(500), AP(5, 'surcharge')]) {
    const r = applyAgreedPrice({ adjustments: [line], previewServiceCents: 0, agreedCents: 10000 });
    expect(r.error).toMatch(/Remove the agreed price line/);
  }
});
```

- [ ] **Step 2:** run (`--testPathPattern=agreedPrice`), FAIL. **Step 3: Implement**: `parseAgreedCents` strips `$`, commas and spaces, requires a finite number `>= 0` and `< MAX_ADJUSTMENT_DOLLARS`; `applyAgreedPrice` finds the index with `source === 'agreed_price'`, refuses when `previewServiceCents === 0` and that line exists, of either type (message "Remove the agreed price line, then set the price again."), backs out its `adjSignedCents`, computes `diff = agreedCents - base`, and removes, replaces in place (keeping `visible`, resetting the label) or appends a hidden line. **Step 4:** PASS. **Step 5: Commit** "feat(editor): agreed-price math".

### Task E4: The editor UI, the stale-save flow, the phone sheet and the staffing prompt

**Files:** Create `client/src/pages/admin/proposalEditor/AgreedPriceControl.js`, `AgreedPriceControl.test.js`; Modify `ProposalEditorForm.js` (remove L735-758; add the control by the adjustment buttons about L677-684; the refund-line confirm; legal-hold read-only; 409 handling), `formState.js` (keep `adjustments_token: proposal.adjustments_token || null`), `patchBody.js` (send `adjustments_token`; stop sending `total_price_override`), `client/src/utils/editSheetView.js` (`editLockedReason` returns a legal-hold reason for `legal_hold: true`; `saveErrorText` maps `STALE_EDIT` and `LEGAL_HOLD`), `client/src/components/mobile/useEditSheet.js` (the Reload path), `client/src/pages/admin/RemoteStaffingFeePrompt.js` (it sends `adjustments` through `buildProposalPatchBody`, so it carries the token from its own GET), `client/src/index.css`; Tests: `patchBody.test.js`, `formState.test.js`, `AgreedPriceControl.test.js`, `editSheetView.test.js`, a new `RemoteStaffingFeePrompt.test.js`.

- [ ] **Step 1: Failing tests:**
  1. `patchBody` sends `adjustments_token` and never `total_price_override`.
  2. AgreedPriceControl: Apply disabled while `previewStale`, while `editPreview` is null, and when the booking still has an override (the form shows "Price override: $X. It converts to an Agreed price adjustment line soon." instead); helper "Before gratuity. Gratuity is added on top.", plus "Includes staffing gratuity." when `editPreview.breakdown` has a row labeled `SHARED_GRATUITY_LABEL` (client mirror `client/src/utils/gratuityLabels.js`; the snapshot's `staffing` has no per-hour gratuity field).
  3. Removing or lowering a `source: 'refund'` line shows the inline confirm "This line records money already refunded. Removing it bills that amount again." and changes nothing until confirmed.
  4. Review Focus 1: an editor opened from a stale proposal (old lines, old token) that changes a line gets 409 `STALE_EDIT`, shows the message with Reload, and makes no second PATCH.
  5. `legal_hold: true`: the editor shows "This booking is on legal hold and can't be edited here." with no Save; `editLockedReason` returns the hold for the phone sheet.
  6. The phone sheet sends the token through `buildProposalPatchBody`; on 409 `saveErrorText` reads the stale message and the sheet offers Reload.
  7. RemoteStaffingFeePrompt passes its GET's `adjustments_token` and adds its surcharge line in one save.
- [ ] **Step 2:** run each, FAIL. **Step 3: Implement** to the tests; `ProposalEditorForm.js` must not grow past 900 lines (the control is its own file). **Step 4:** PASS. **Step 5: Commit** "feat(editor): Set agreed price replaces the override; stale saves reload; legal hold is read-only".

### Task E5: Docs and walkthroughs

- [ ] README: `patchGuards.js`, `agreedPrice.js`, `AgreedPriceControl.js`; ARCHITECTURE: the PATCH row notes `adjustments_token`, the 409 codes `STALE_EDIT` and `LEGAL_HOLD`, and the adjustment validation; the GET row notes `legal_hold` and `adjustments_token`. `scripts/sensitive-paths.txt`: `patchGuards.js` and `client/src/pages/admin/proposalEditor/agreedPrice.js` (it computes a money line; its siblings are listed). `docs/walkthroughs-owed.md`: "Set agreed price on a dev booking (lower, higher, again, zero)"; "Open the editor, add a line from another tab, then save the first: refused with Reload; a client page view in between does not refuse"; "Remote staffing fee prompt adds its surcharge". Commit "docs(editor): agreed price, stale lines, legal hold".

---

## Lane line-protection

### Task P1: The engine marks visibility on breakdown rows

**Files:** Modify `server/utils/pricingEngine.js:574-580`; Test: the engine's test file.

- [ ] **Step 1: Failing test:** `calculateProposal` with one visible and one hidden adjustment returns breakdown rows `{ label, amount, visible: true }` and `{ ..., visible: false }`; non-adjustment rows have no `visible` key.
- [ ] **Step 2:** FAIL. **Step 3:** add `visible: !!adj.visible` to the pushed row. **Step 4:** run every engine suite and `invoiceLineItems.test.js`, `payrollMath` tests; update any deep-equal on breakdown rows (adding the key only; a grep found none outside the engine suites, so nothing outside the footprint should change). PASS. **Step 5: Commit** "feat(pricing): breakdown adjustment rows carry visibility".

### Task P3: Admin views tag hidden lines and drop the remove button on protected ones

**Files:** Create `client/src/utils/hiddenRows.js`, `hiddenRows.test.js`; Modify `client/src/components/PricingBreakdown.js` (render L85-101), `client/src/utils/eventDetailView.js` (`financialsOf` L233-243), `client/src/pages/mobile/EventDetailSections.js:95-100` (where the phone draws `fin.lines`), `client/src/index.css`; Tests: `hiddenRows.test.js`, the PricingBreakdown test, `eventDetailView.test.js`, `EventDetailPhone.test.js`.

**Interfaces:** `hiddenRowFlags(snapshot) -> boolean[]` aligned with `snapshot.breakdown`.

- [ ] **Step 1: Failing tests:** (a) new snapshots: rows carrying `visible` use it; (b) old snapshots (no key anywhere): adjustment rows matched in engine order to `snapshot.adjustments` by `adjLabel` and `adjSignedCents`, a missing `visible` on the adjustment reading hidden; (c) a MIXED snapshot (an old snapshot that later got a server-written row with `visible`: Refund line, converted line): the older hidden lines stay tagged; (d) non-adjustment rows are never flagged, including 'Shared Gratuity' rows; (e) `PricingBreakdown` shows "hidden from client" on flagged rows and no remove button on a matched target with `reason: 'protected_line'`; (f) `financialsOf` lines carry `hidden: true` and the phone (`EventDetailPhone.test.js`) shows the tag.
- [ ] **Step 2:** FAIL. **Step 3: Implement**

```js
// client/src/utils/hiddenRows.js
import { adjVisible, adjLabel, adjSignedCents } from './adjustmentRules';
const toCents = (n) => Math.round(Number(n || 0) * 100);
const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
// Per row: an adjustment row (matched in engine order) takes its own `visible`
// when it carries one, else the adjustment's; any other row is never hidden.
export function hiddenRowFlags(snapshot) {
  const rows = (snapshot && Array.isArray(snapshot.breakdown)) ? snapshot.breakdown : [];
  const adjs = (snapshot && Array.isArray(snapshot.adjustments)) ? snapshot.adjustments : [];
  let k = 0;
  return rows.map((r) => {
    const a = adjs[k];
    if (a && r && r.label === adjLabel(a) && toCents(r.amount) === adjSignedCents(a)) {
      k += 1;
      return hasOwn(r, 'visible') ? !r.visible : !adjVisible(a);
    }
    return hasOwn(r, 'visible') ? !r.visible : false;
  });
}
```

The tag reuses `.chip` with a muted modifier in the admin block of `index.css`. **Step 4:** PASS. **Step 5: Commit** "feat(admin): hidden lines are tagged; protected lines lose the remove button". **Step 6:** README line for `hiddenRows.js`; walkthroughs-owed "Admin breakdown on desktop and phone tags hidden lines; refund and agreed-price lines have no remove button". Commit.

---

## Lane refund-line

### Task R1: The refund line writer

**Files:** Create `server/utils/refundLine.js`; Test: `server/utils/refundLine.test.js` (DB).

**Interfaces:** `appendRefundLine(dbClient, { proposalId, refundId, contractCents }) -> Promise<{ written: boolean }>`. The caller holds the row lock inside its transaction. Uses `isLegalHold` (A2) and `insertAdjustmentBreakdownRow` (A2).

- [ ] **Step 1: Failing DB tests** (synthetic proposals):
  1. A snapshot with a staffing 'Shared Gratuity' row, one add-on, and a client Gratuity row (gratuity 40): appends `{ type: 'discount', label: 'Refund', amount: 285, visible: true, source: 'refund', refund_id }` to `proposals.adjustments` and `pricing_snapshot.adjustments`, inserts `{ label: 'Refund', amount: -285, visible: true }` immediately before the client Gratuity row, and lowers `pricing_snapshot.total` by 285 floored at 0.
  2. A `{}` snapshot (the column default every existing refund suite inserts): the row's `adjustments` gains the line and the snapshot becomes `{ adjustments: [line], breakdown: [row] }` with no `total` invented.
  3. `contractCents <= 0` writes nothing; an injected legal-hold id writes nothing; a second call with the same `refundId` writes nothing (found by `refund_id`).
- [ ] **Step 2:** `node --test server/utils/refundLine.test.js`, FAIL. **Step 3: Implement**: one SELECT of `adjustments, pricing_snapshot`, the skips, then one `UPDATE proposals SET adjustments = $2, pricing_snapshot = $3 WHERE id = $1`. **Step 4:** PASS. **Step 5: Commit** "feat(refunds): the refund line writer".

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
- [ ] **Step 6:** README and ARCHITECTURE (refund section: the line, its markers, the legal-hold skip; `server/utils/refund*.js` is already sensitive-listed); fix list: the refund entry gets "Built in lane refund-line (<merge sha>); existing bookings close with step 2"; `docs/walkthroughs-owed.md`: "A refund on a dev booking writes a visible Refund line and the next editor save bills nothing (dev talks to live Stripe: the smallest real amount on a booking Dallas names, or skip and rely on the suites)". Commit.

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
- [ ] **Step 6:** README, ARCHITECTURE (the `GET /api/invoices/t/:token` row notes `contract_step`; `server/utils/invoice*.js` is already sensitive-listed), walkthroughs-owed "Deposit and Balance invoice, screen and Save as PDF". Commit.

---

## Lane fold-holds

### Task F1: The legal-hold guard in the fold and the switch

**Files:** Modify `server/utils/proposalExtrasFold.js` (top of `foldExtrasIntoProposal`, L110), `server/routes/proposals/publicSwitch.js` (the predicate at L177-182); Create `server/routes/proposals/cancelLineItem.legalHold.test.js`, `server/routes/proposals/publicSwitch.legalHold.test.js`; a fold-level case in a new `server/utils/proposalExtrasFold.legalHold.test.js`.

- [ ] **Step 1: Failing tests** (holds injected with `__setLegalHoldIdsForTest`): the fold throws `ConflictError("This booking can't be changed online right now.", 'NOT_CHANGEABLE')` before any write; cancel-line on a held fixture returns 409 and the row is unchanged (the route reaches the fold at `lineItemCancel.js:613`); the switch refuses a held fixture with its existing `SWITCH_NOT_AVAILABLE` answer (same message as today). In the fold test's header, record for each production caller (`lineItemCancel.js:613`, `drinkPlans/submit.js:450`, `drinkPlans/lab.js:344`) the line that ROLLBACKs on a throw.
- [ ] **Step 2:** FAIL. **Step 3:** `if (isLegalHold(proposal.id)) throw ...` first in the fold; `|| isLegalHold(p.id)` joins the switch predicate. **Step 4:** PASS, plus every existing fold suite (`proposalExtrasFold.stability.test.js`, `.legs.test.js`, `contractDuration.extension.test.js`) and `publicSwitch.test.js` one at a time. **Step 5: Commit** "feat(proposals): legal-hold bookings refuse every client-triggered re-price".

### Task F2: The shared catalog compute

**Files:** Modify `server/utils/proposalExtrasFold.js` (extract from L131-205; export at L252); Test: `server/utils/proposalExtrasFold.catalog.test.js` (DB).

**Interfaces:** `computeCatalogSnapshot(client, proposal, { adjustments } = {}) -> Promise<snapshot>`: the engine output for the booking's CURRENT inputs at today's catalog with no override: `SELECT * FROM service_packages WHERE id = $1`; add-ons via `loadRepriceAddons(client, proposal.id)`; syrups from `proposal.pricing_snapshot.syrups.selections` AS STORED (they are already post-filter; the conversion has no request to filter with); `numBars = proposal.num_bars ?? 0`; `numBartenders = proposal.num_bartenders`; contract hours via `contractDurationHours`; gratuity rate, tip jar and mandate floor from the row; `adjustments ?? proposal.adjustments ?? []`; `totalPriceOverride: null`.

- [ ] **Step 1: Failing test:** for a native fixture, `computeCatalogSnapshot` deep-equals (excluding `calculated_at`) the snapshot `foldExtrasIntoProposal` writes when called with before == after (no extras change), inside a rolled-back transaction; and both go through one internal `catalogEngineArgs(...)`.
- [ ] **Step 2:** FAIL. **Step 3:** extract `catalogEngineArgs`; no behavior change to the fold. **Step 4:** PASS plus every fold suite. **Step 5: Commit** "refactor(fold): one catalog compute shared with the conversion". ARCHITECTURE line for the export.

---

## Lane conversion-tooling

### Task V1: The branch, the export, the fresh compute

**Files:** Create `scripts/override-conversion/branch.js`, `scripts/override-conversion/export.sql`, `scripts/override-conversion/export.js`, `scripts/override-conversion/freshCompute.js`.

- [ ] **Step 1: `branch.js`.** Creates a branch of prod (`--parent` defaults to `br-noisy-frog-ad99sa6l`, project `round-tooth-34649976`; the rehearsal passes the dev branch) named `override-conversion-<YYYYMMDD-HHMM>` through the Neon REST API with `NEON_API_KEY` (key loading as `testdb-smoke.js` does), with `endpoints: [{ type: 'read_write' }]` in the create request, waits until the endpoint is ready, writes the connection URI to a chmod-600 file in the session scratchpad (never stdout), and prints the branch id. `--delete <id>` refuses any branch whose name does not start with `override-conversion-` (so it can never touch `ci-smoke` / `br-twilight-surf-adf8eghx` or prod).
- [ ] **Step 2: `export.sql` + `export.js <uri-file> <out.json>`.** Runs over `pg` against the BRANCH (decision 10; nothing passes through MCP or this chat). One read-only query returning: every proposal with `total_price_override IS NOT NULL`, every proposal with a succeeded contract-scope refund, each with `id, status, total_price, amount_paid, total_price_override, adjustments, pricing_snapshot, package_id, num_bars, num_bartenders, event_duration_hours, gratuity_rate, tip_jar, gratuity_floor_rate` and `md5(row(total_price, amount_paid, status, total_price_override, adjustments, pricing_snapshot)::text) AS money_md5`; their succeeded refunds (`id, amount, total_scope, total_price_before, total_price_after, created_at`); their `proposal_addons` rows in the shape `buildInvoiceLineItems` reads; Additional Services invoices created after each refund (`id, created_at, amount_due`); pending change requests (`id, created_at`). No names, emails or phones.
- [ ] **Step 3: `freshCompute.js <uri-file> <export.json> <out.json>`.** Spawns a child with `DATABASE_URL` set to the branch URI BEFORE any server module loads (`server/db/index.js` binds at load; `testdb-smoke.js:206-218` precedent); the child, inside `BEGIN ... ROLLBACK`, runs `computeCatalogSnapshot` (F2) for each live id and writes `{ id, freshServiceCents, snapshot }`.
- [ ] **Step 4: Commit** "feat(scripts): override conversion branch, export and fresh compute". (Exercised end to end by the V4 rehearsal.)

### Task V2: The transform

**Files:** Create `scripts/override-conversion/transform.js`, `transform.test.js`.

**Interfaces:** `planConversion({ rows, fresh, legalHoldIds }) -> { changes: Change[], report: ReportRow[], dallasLists }`.
- `Change = { id, kind: 'override_live' | 'override_terminal' | 'refund_backfill', money_md5, before, after: { adjustments, pricing_snapshot, total_price_override }, lines }`.
- `ReportRow = { id, status, kind, lines: [{ type, label, amount }], catalogDriftCents (live only: freshServiceCents minus the stored snapshot's service total), pageVerdict (buildClientPriceRows on the AFTER snapshot: 'none' | 'package' | 'fallback' | 'skipped'), invoiceVerdict (buildInvoiceLineItems on the after snapshot with the exported add-on rows and total_price: its fold's applied), pendingChangeRequests }`.
- `dallasLists = { snapshotMismatch, refundGapZero (with any Additional Services invoice after the refund), refundGapUnequal }`.

Rules (spec 8.2-8.4): live overrides use `fresh` (line = override - freshServiceCents; after snapshot = fresh with the line appended through `insertAdjustmentBreakdownRow`; gate after total == total_price); terminal overrides in place (line = override - max(0, subtotal + net) via `adjSignedCents`); **refunds on a booking that carries an override at conversion are absorbed by its agreed-price line and are never backfilled** (527, 599); backfill only on no-override bookings, one line per succeeded contract refund lacking a line with its `refund_id`, only when the snapshot gap equals the unbacked drops; a missing `snapshot.gratuity` is 0; every written line passes `validateAdjustments`; legal-hold ids appear nowhere.

- [ ] **Step 1: Failing tests** on SYNTHETIC rows, one per shape: live override (fresh); terminal plain override; existing adjustments (net -237.50 style); the 527/599 shape (row override below the snapshot's, plus its refund: one agreed-price line, NO Refund line); an even row; a backfill with two contract refunds; a booking whose step-1 refund already has its line; Review Focus 4 (one overpayment and one contract refund: one line); gap 0 with an unbacked refund (listed); unequal gap (listed); snapshot/row lines mismatch (listed, unchanged); a legal-hold id; the 59 shape (untouched); a missing gratuity; and the report's drift and both verdicts on a live row that lands on the fallback.
- [ ] **Step 2:** FAIL. **Step 3:** implement (pure; cents for every compare). **Step 4:** PASS. **Step 5: Commit** "feat(scripts): override conversion transform and report".

### Task V3: The compact DO blocks

**Files:** Create `scripts/override-conversion/doBlock.js`, `doBlock.test.js` (dev DB), `scripts/override-conversion/run.js` (export JSON + fresh JSON in; report, forward block, reverse block out to the scratchpad).

**Interfaces:** `renderForwardBlock(changes) -> string`, `renderReverseBlock(changes) -> string`.

Block shape (decision 10): one `DO $conv$ ... $conv$`; `PERFORM 1 FROM proposals WHERE id = ANY(<ids>) FOR UPDATE`; per row `IF md5(row(total_price, amount_paid, status, total_price_override, adjustments, pricing_snapshot)::text) IS DISTINCT FROM '<money_md5>' THEN RAISE EXCEPTION ...` (no `updated_at` anywhere: page views move it); in-place rows written with jsonb operations (append the line to `adjustments` and `pricing_snapshot->'adjustments'`, place the breakdown row by the A2 rule through an ordinality re-aggregation, set `total`, null the override); live rows written with their full after-snapshot literal (4 of them); after each write `GET DIAGNOSTICS n = ROW_COUNT` must be 1; then, inside the block, assert `adjustments = pricing_snapshot->'adjustments'` and `round(GREATEST(0, (pricing_snapshot->>'subtotal')::numeric + <net of the written adjustments>) + COALESCE((pricing_snapshot->'gratuity'->>'total')::numeric, 0), 2) = total_price` and `(pricing_snapshot->>'total')::numeric = total_price`; insert one `proposal_activity_log` row (`price_override_converted` or `refund_line_backfilled`, `actor_type 'system'`). JSON literals are dollar-quoted with a tag the renderer proves absent. The reverse block restores each row's before-state (money columns only, never `updated_at`), guarded by the after-state md5.

- [ ] **Step 1: Failing DB tests** on synthetic fixtures for EVERY shape V2 covers: the forward block's written rows deep-equal V2's after-states; spec 10: after converting a live-shape fixture, `foldExtrasIntoProposal` adding one syrup raises `total_price` by exactly that syrup's catalog price; one fixture altered after rendering makes the block RAISE and leaves every fixture unchanged; a deliberately wrong line amount trips the in-block arithmetic assertion; a NULL where a value was expected RAISEs; the reverse block restores every money column and refuses a row not in its after-state.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS; run twice to prove cleanup. **Step 5: Commit** "feat(scripts): compact guarded forward and reverse blocks for the conversion".

### Task V4: The rehearsal and the runbook

**Files:** Create `docs/runbooks/override-conversion.md`; README script lines; `scripts/sensitive-paths.txt` adds `scripts/override-conversion/*` (confirm with `node scripts/sensitive-match.js scripts/override-conversion/transform.js`).

- [ ] **Step 1: Rehearse on dev.** Seed synthetic rows of every shape on the dev branch, then run the whole pipeline: `branch.js --parent <dev branch>`, `export.js`, `freshCompute.js`, `run.js`, the forward block (over `pg` against the rehearsal branch), the confirmation query, the reverse block, `branch.js --delete`. Record the run in the runbook.
- [ ] **Step 2: Write the runbook**, each step with its command:
  1. Confirm no push is running and push 1 is live. Confirm `scripts/cc-transfer-events.js` has not been run since push 1: the export's override ids must be a subset of the 2026-10-16 census (38 rows); any new id stops the run.
  2. Cut the branch; export; fresh compute; `run.js` (report and blocks land in the scratchpad only: they carry free-text labels and the repo is public).
  3. Review pass on the rendered SQL against the change set: `database-review` and `consistency-check`.
  4. Dallas reads the report and his lists, and settles pending change requests on the live rows.
  5. Immediately before running: re-cut the branch, re-export, re-run, diff the change set. Identical: proceed under his go. Different: back to him.
  6. Run the forward block through Neon MCP `run_sql` on the prod branch.
  7. Confirmation query: no override outside the legal-hold list; `snapshot.total = total_price` on every changed row; every non-hold contract refund has a line, sits on an override-absorbed booking (527, 599), or is on his list.
  8. Fix list: close the refund entry for every booking the backfill wrote; keep his listed bookings open with their ids.
  9. Keep the branch until he confirms; then `branch.js --delete`.
- [ ] **Step 3: Commit** "docs(runbook): the override conversion, rehearsed on dev".

---

## Gate registration (one commit after the last push-1 lane merges; one after override-removal for push 2)

- [ ] Add every new DB money suite to `scripts/money-smoke-list.txt` in one commit on main (sensitive-listed; one writer, so parallel lanes never collide): `server/utils/adjustmentRules.test.js`, `server/utils/legalHold.test.js`, `server/routes/proposals/cancelLineItem.protected.test.js`, `server/utils/clientPriceLines.test.js`, `server/utils/publicSnapshot.test.js`, `server/routes/proposals/publicLeak.test.js`, the portal route test touched in Q1, `server/routes/proposals/patchGuards.test.js`, `server/routes/proposals/crud.guards.test.js`, `server/utils/refundLine.test.js`, `server/utils/refundHelpers.line.test.js`, `server/utils/invoiceStep.test.js`, the invoice route test from I2, `server/utils/proposalExtrasFold.legalHold.test.js`, `server/routes/proposals/cancelLineItem.legalHold.test.js`, `server/routes/proposals/publicSwitch.legalHold.test.js`, `server/utils/proposalExtrasFold.catalog.test.js`, and (when conversion-tooling is merged) `scripts/override-conversion/transform.test.js`, `scripts/override-conversion/doBlock.test.js`. Then `npm run gate` and read the pass count. Push 2: drop any suite override-removal deletes and add any it creates.

---

## Lane override-removal (push 2; cut only after the step 2 confirmation query is clean)

### Task X1: The engine and the server stop reading the override

**Files:** every server file in spec section 9.

- [ ] **Step 1: Failing tests first:** the engine ignores a `totalPriceOverride` argument (serviceTotal = calculatedTotal); the PATCH refuses any body carrying `total_price_override` with a ValidationError ("field not accepted"); `/calculate` ignores it; `publicToken`'s `options_available` no longer reads the column; `publicOptions` no longer returns `custom_pricing`; `publicSwitch` no longer refuses on the column; the refund money UPDATE no longer touches the column; `changeRequests` and `changeRequestNotifications` no longer read it; `serviceExtensionPricing` no longer selects it (L120).
- [ ] **Step 2:** FAIL. **Step 3:** remove the override from: `pricingEngine.js`; `routes/proposals/crud.js` (destructure, L463-470 bounds, `TOTAL_PRICE_OVERRIDE_MAX`, UPDATE column $16 and its value; the step 1 equal-override acceptance in `patchGuards.js` becomes a refusal); `routes/proposals/metadata.js`; `utils/proposalExtrasFold.js` (the override branch L131-190 and the column in the write; `computeCatalogSnapshot` stays); `utils/refundHelpers.js` (the CASE and its comment); `utils/changeRequests.js`; `utils/changeRequestNotifications.js`; `utils/serviceExtensionPricing.js`; `routes/proposals/publicToken.js`; `routes/proposals/publicOptions.js`; `routes/proposals/publicSwitch.js`; `routes/proposals/optionsPricingShared.js`; `routes/clientPortal.js` and `routes/clientPortal/summary.js` (any remaining reference). **Step 4:** run every touched suite one at a time; PASS. **Step 5: Commit** "feat(pricing): the price override is retired".

### Task X2: The client, the scripts, the schema comment, the docs

- [ ] Client: `proposalEditor/{formState.js, patchBody.js, editorCore.js, ProposalEditorForm.js}` drop every override reference (the step 1 read-only notice included); `pages/public/portal/constants.js`. `server/utils/contractDuration.extension.test.js` drops its `total_price_override` key (L141). `server/utils/invoiceLineItems.js` prose naming the override (L36, L72) is reworded. Delete `scripts/cc-transfer-events.js`, `scripts/cc-transfer-events.test.js`, `scripts/cc-balance-invoice.js` (git rm, with Dallas's per-action yes per the destructive-ops rule). `schema.sql` about L1326: the column is commented as retired, holding only legal-hold data. Update the about 23 test files that reference the override. ARCHITECTURE (the L355, L378, L379, L412, L1150, L1878, L2084 areas) and README (L752) per spec 9.1. Fix list: the duration entry closes. Final check: `grep -rn "total_price_override" server client/src scripts docs *.md`; the accepted leftovers are the schema comment, the legal-hold note, history docs, this plan and its spec, `scripts/override-conversion/*`, `docs/runbooks/override-conversion.md`, `scripts/sensitive-paths.txt`, `docs/build-board.md`, `docs/fix-list-remaining-2026-07-02.md` and `docs/client-portal-v2-project.md`; anything else is a miss. Commit "chore(pricing): override references removed; CC cutover scripts retired".

---

## Execution

- Lanes are cut as worktrees off current `main` (`npm run worktree:new`), built, and reviewed with the full fleet per lane before merge (`scripts/merge-lane.sh`).
- Order: `adj-rules` first. Then `client-rows`, `editor`, `line-protection`, `refund-line`, `invoice-step` and `fold-holds` in parallel (`invoice-step` may start at once). `portal-rows` after `client-rows`. `conversion-tooling` after `client-rows`, `fold-holds` and `refund-line`.
- Push 1: after the eight runtime lanes merge, the gate-registration commit, then the push-time sweep, `/second-opinion` and `npm run gate`. Push 2 gets the same: push-time fleet, `/second-opinion`, `npm run gate`.
- Shared files across parallel lanes (`README.md`, `ARCHITECTURE.md`, `docs/walkthroughs-owed.md`, `docs/fix-list-remaining-2026-07-02.md`, `scripts/sensitive-paths.txt`, `client/src/index.css`) conflict textually only; resolve at merge, keep both sides. A conflict on a sensitive-listed file still goes to Dallas per the merge model.
- Inside a lane: one implementer builds the lane's tasks in order (TDD as written), then the lane's full fleet reviews before merge.
