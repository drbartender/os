# Drink-Plan Override Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a client's drink-plan submit from destroying a negotiated price, while still charging for the extras they added.

**Architecture:** `server/routes/drinkPlans/submit.js` re-prices from catalog and drops `total_price_override`. Fix by branching: proposals with no override keep today's exact catalog recompute; proposals with an override get `newOverride = oldOverride + catalogDelta`, where the delta is priced by two engine calls with the override OFF so everything unchanged by the submit cancels. Then a one-time operator script mints the remaining CC balance invoices in the shape the invoice generator cannot produce.

**Tech Stack:** Node/Express, node:test, pg, Neon Postgres.

Spec: `docs/superpowers/specs/2026-07-16-drink-plan-override-preservation-design.md`

## Global Constraints

- Money on `proposals` is **DOLLARS** (`NUMERIC(10,2)`); money on `invoices` / `invoice_line_items` / `proposal_payments` is **INTEGER CENTS**. Never cross a formatter.
- Round every dollar result with `Math.round(x * 100) / 100`.
- The **native path (`total_price_override IS NULL`) must stay behaviorally identical.** That is the primary review question.
- No em dashes in prose or copy. Use commas, periods, colons, parentheticals.
- Build in a lane off `main`; `os` never leaves `main`. Squash-merge back. Do NOT push. The review fleet runs before any push.
- A lane has no `.env`. Copy it before running any DB test: `cp ~/projects/os/.env ../worktrees/<lane>/.env` (gitignored, never commits).
- Server tests share the dev DB. Run **one suite at a time**, never the full `npm test` in parallel with another suite.

---

### Task 1: Lane setup

**Files:**
- Create: worktree `../worktrees/drink-plan-override`

- [ ] **Step 1: Cut the lane off current main**

```bash
cd ~/projects/os
git switch main && git pull --ff-only 2>/dev/null || true
npm run worktree:new drink-plan-override
```

- [ ] **Step 2: Wire the env so DB tests can run**

```bash
cp ~/projects/os/.env ~/projects/worktrees/drink-plan-override/.env
cd ~/projects/worktrees/drink-plan-override && git status --short
```

Expected: clean tree (the `.env` is gitignored). If `git status` shows noise, stop and fix `.gitignore` before continuing.

---

### Task 2: The failing regression test (Jack Van Dyke)

**Files:**
- Create: `server/routes/drinkPlans/submitOverride.test.js`
- Test: `node --test server/routes/drinkPlans/submitOverride.test.js`

**Interfaces:**
- Consumes: `drinkPlansRouter` from `server/routes/drinkPlans`, `pool` from `server/db`, `AppError` from `server/utils/errors`.
- Produces: nothing (test only).

**Why this shape:** hand-rolled express harness driven over HTTP, mirroring `submitReconcile.test.js`. The submit route is public and token-gated, so no auth. Rows are nonce-suffixed so a crashed prior run cannot collide, and every seeded row is torn down in `after()`.

- [ ] **Step 1: Write the failing test**

```js
require('dotenv').config();

// Regression: a client-submitted drink plan carrying a financial extra must NOT
// destroy a negotiated price (proposals.total_price_override).
//
// Origin: Jack Van Dyke (prod proposal 600, 2026-07-16). CC contract $3,273.
// He added a second portable bar in the planner; submit re-priced him at full
// catalog ($4,000), left the override column stranded at 3273, and emailed him
// a $3,900 balance. See docs/superpowers/specs/2026-07-16-drink-plan-override-
// preservation-design.md.
//
// The rule: newOverride = oldOverride + catalogDelta. The delta is priced with
// the override OFF, so anything this submit did not change cancels out. That is
// why the CC-era bundled first bar (first_bar_fee) must NOT appear in the
// delta: it is in the catalog on both sides. Only the genuine second bar
// (additional_bar_fee) is added.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const drinkPlansRouter = require('../drinkPlans');

let server;
let baseUrl;
let clientId;
let pkg;
const seeded = []; // { proposalId, planToken }

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const CONTRACT = 3273; // Jack's CC contract price, in DOLLARS

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const bodyBuf = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// Seed one proposal + drink plan. `override` null => native (no negotiated price).
async function seedProposal({ override, adjustments = [] }) {
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, package_id, event_type, guest_count, num_bars, num_bartenders,
        total_price, total_price_override, amount_paid, external_paid,
        adjustments, autopay_enrolled, pricing_snapshot)
     VALUES ($1, CURRENT_DATE + 30, '14:00', 4, 'America/Chicago',
             'confirmed', $2, 'wedding-reception', 175, 1, 2,
             $3, $4, 100, 100, $5, false, '{}'::jsonb)
     RETURNING id`,
    [clientId, pkg.id, override ?? 1000, override, JSON.stringify(adjustments)]
  );
  const proposalId = p.rows[0].id;
  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, client_name, client_email)
     VALUES ($1, 'draft', '{}'::jsonb, $2, $3) RETURNING token`,
    [proposalId, `Override Test ${NONCE}`, `override-${NONCE}@example.com`]
  );
  const rec = { proposalId, planToken: dp.rows[0].token };
  seeded.push(rec);
  return rec;
}

before(async () => {
  // A per_guest, non-class package with BOTH bar fees, so the delta can prove
  // the first-bar fee cancels and only the additional-bar fee lands.
  const pk = await pool.query(
    `SELECT * FROM service_packages
      WHERE is_active = true AND pricing_type = 'per_guest' AND bar_type <> 'class'
        AND first_bar_fee > 0 AND additional_bar_fee > 0
      ORDER BY id LIMIT 1`
  );
  assert.ok(pk.rows[0], 'need an active per_guest, non-class package with both bar fees');
  pkg = pk.rows[0];

  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551212') RETURNING id",
    [`Override Test ${NONCE}`, `override-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/drink-plans', drinkPlansRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  // Let fire-and-forget submit side-effects (shopping-list gen, email lookup) settle.
  await new Promise((r) => setTimeout(r, 300));
  for (const { proposalId } of seeded) {
    await pool.query("DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id=$1)", [proposalId]);
    await pool.query("DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id=$1)", [proposalId]);
    await pool.query("DELETE FROM invoices WHERE proposal_id=$1", [proposalId]);
    await pool.query("DELETE FROM proposal_addons WHERE proposal_id=$1", [proposalId]);
    await pool.query("DELETE FROM proposal_activity_log WHERE proposal_id=$1", [proposalId]);
    await pool.query("DELETE FROM drink_plans WHERE proposal_id=$1", [proposalId]);
    await pool.query("DELETE FROM proposals WHERE id=$1", [proposalId]);
  }
  await pool.query("DELETE FROM clients WHERE id=$1", [clientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('overridden proposal: a second bar adds exactly additional_bar_fee and the contract survives', async () => {
  const { proposalId, planToken } = await seedProposal({ override: CONTRACT });

  const res = await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: {
      status: 'submitted',
      paid_separately: false, // add-to-balance branch
      selections: { logistics: { addBarRental: true } },
    },
  });
  assert.strictEqual(res.status, 200);

  const row = (await pool.query(
    'SELECT total_price, total_price_override, num_bars, pricing_snapshot FROM proposals WHERE id = $1',
    [proposalId]
  )).rows[0];

  const expected = CONTRACT + Number(pkg.additional_bar_fee);

  // num_bars 1 -> 2. The bar he already had is in the catalog on BOTH sides of
  // the delta, so its first_bar_fee cancels and must not be charged.
  assert.strictEqual(row.num_bars, 2, 'the added bar is recorded');
  assert.strictEqual(Number(row.total_price_override), expected,
    'the contract must move by exactly the additional-bar fee');
  assert.strictEqual(Number(row.total_price), expected,
    'total_price must track the contract, not the catalog');
  assert.strictEqual(Number(row.pricing_snapshot.total), expected,
    'the snapshot total must agree with total_price');
  assert.strictEqual(Number(row.pricing_snapshot.total_price_override), expected,
    'the snapshot must carry the new contract, not null');

  // The bug: catalog for 175 guests is far above the negotiated contract.
  const catalogish = Number(pkg.base_rate_4hr) * 175;
  assert.ok(Number(row.total_price) < catalogish,
    'must NOT be re-priced at catalog (this is the Jack Van Dyke regression)');

  // The opposite bug: preserving the override naively makes the extra free.
  assert.ok(Number(row.total_price) > CONTRACT,
    'the extra must actually be charged, not given away');
});

test('overridden proposal: the first-bar fee never enters the delta', async () => {
  const { proposalId, planToken } = await seedProposal({ override: CONTRACT });
  await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: { status: 'submitted', paid_separately: false, selections: { logistics: { addBarRental: true } } },
  });
  const row = (await pool.query('SELECT total_price FROM proposals WHERE id = $1', [proposalId])).rows[0];
  const wrong = CONTRACT + Number(pkg.first_bar_fee) + Number(pkg.additional_bar_fee);
  assert.notStrictEqual(Number(row.total_price), wrong,
    'the contractually included first bar must not be re-charged');
});

test('native proposal (no override) keeps the catalog recompute and stays un-overridden', async () => {
  const { proposalId, planToken } = await seedProposal({ override: null });

  const res = await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: { status: 'submitted', paid_separately: false, selections: { logistics: { addBarRental: true } } },
  });
  assert.strictEqual(res.status, 200);

  const row = (await pool.query(
    'SELECT total_price, total_price_override, pricing_snapshot FROM proposals WHERE id = $1',
    [proposalId]
  )).rows[0];

  assert.strictEqual(row.total_price_override, null,
    'a native proposal must never acquire an override');
  // Catalog recompute: guest-driven base, well above the seeded $1,000 placeholder.
  assert.ok(Number(row.total_price) > 1000, 'native path still re-prices from catalog');
  assert.strictEqual(Number(row.pricing_snapshot.total), Number(row.total_price));
});

test('overridden proposal keeps its visible adjustment lines in the rebuilt breakdown', async () => {
  const adjustments = [{ type: 'discount', label: 'Corporate 3-Night Rate', amount: 100, visible: true }];
  const { proposalId, planToken } = await seedProposal({ override: CONTRACT, adjustments });

  await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: { status: 'submitted', paid_separately: false, selections: { logistics: { addBarRental: true } } },
  });

  const snap = (await pool.query('SELECT pricing_snapshot FROM proposals WHERE id = $1', [proposalId])).rows[0].pricing_snapshot;
  assert.strictEqual(snap.adjustments.length, 1, 'adjustments must survive the submit recompute');
  assert.strictEqual(snap.adjustments[0].label, 'Corporate 3-Night Rate');
  assert.ok(
    snap.breakdown.some(l => l.label === 'Corporate 3-Night Rate' && l.amount === -100),
    'the discount must render as a negative breakdown line'
  );
});

test('a submit with no financial extras moves no money', async () => {
  const { proposalId, planToken } = await seedProposal({ override: CONTRACT });

  const res = await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: { status: 'submitted', paid_separately: false, selections: { mocktails: ['shirley-temple-deluxe'] } },
  });
  assert.strictEqual(res.status, 200);

  const row = (await pool.query('SELECT total_price, total_price_override FROM proposals WHERE id = $1', [proposalId])).rows[0];
  assert.strictEqual(Number(row.total_price), CONTRACT);
  assert.strictEqual(Number(row.total_price_override), CONTRACT);
});
```

- [ ] **Step 2: Run the test and verify it fails for the right reason**

Run: `node --test server/routes/drinkPlans/submitOverride.test.js`

Expected: the first test FAILS. `total_price_override` is still `3273` while `total_price` has jumped to the catalog figure (~$3,850+). The "must move by exactly the additional-bar fee" assertion is the one that trips. If it fails for any OTHER reason (seed error, 500, missing package), fix the harness before touching `submit.js`.

- [ ] **Step 3: Commit the failing test**

```bash
git add server/routes/drinkPlans/submitOverride.test.js
git commit -m "test(drink-plans): failing regression for override destroyed by submit

Reproduces Jack Van Dyke (prod 600): a client-added bar re-prices a CC
contract at catalog and strands total_price_override."
```

---

### Task 3: Preserve the override with the catalog-delta rule

**Files:**
- Modify: `server/routes/drinkPlans/submit.js` (the `if (proposal)` pricing block, roughly lines 203-275)
- Test: `node --test server/routes/drinkPlans/submitOverride.test.js`

**Interfaces:**
- Consumes: `calculateProposal` from `server/utils/pricingEngine` (already imported at `submit.js:10`), `numBarsAtIntent` (already captured at transaction scope before the increment).
- Produces: no new exports. `proposals.total_price_override` is now written by this handler.

- [ ] **Step 1: Capture the pre-extras add-on set before the upsert mutates it**

In `submit.js`, immediately BEFORE the `if (addBarRental) { ... }` num_bars increment block, insert:

```js
        // Pre-extras catalog baseline. Captured BEFORE the num_bars increment
        // and the add-on upsert below, so a negotiated proposal can price the
        // delta of exactly what the client just added. numBarsAtIntent is the
        // pre-increment count (same value computeExtrasBreakdown keys the
        // first-vs-additional bar fee off). Syrups come off the pre-update
        // snapshot for the same reason.
        const preAddonsRes = await client.query(
          'SELECT sa.* FROM proposal_addons pa JOIN service_addons sa ON sa.id = pa.addon_id WHERE pa.proposal_id = $1',
          [proposal.id]
        );
        const preSyrups = proposal.pricing_snapshot?.syrups?.selections || [];
```

- [ ] **Step 2: Replace the snapshot computation and the UPDATE**

Find this block (roughly lines 255-275):

```js
        if (pkg && proposal.guest_count && proposal.event_duration_hours) {
          const rawSyrups = selections.syrupSelections || {};
          const syrupSels = Array.isArray(rawSyrups)
            ? rawSyrups
            : [...new Set(Object.values(rawSyrups).flat())];
          const snapshot = calculateProposal({
            pkg,
            guestCount: proposal.guest_count,
            durationHours: Number(proposal.event_duration_hours),
            numBars: proposal.num_bars ?? 0,
            numBartenders: proposal.num_bartenders,
            addons: allAddonsRes.rows,
            syrupSelections: syrupSels, gratuityRate: proposal.gratuity_rate, tipJar: proposal.tip_jar, // §5 preserve stored gratuity
          });

          await client.query(
            'UPDATE proposals SET total_price = $1, pricing_snapshot = $2, updated_at = NOW() WHERE id = $3',
            [snapshot.total, JSON.stringify(snapshot), proposal.id]
          );
```

Replace it with:

```js
        if (pkg && proposal.guest_count && proposal.event_duration_hours) {
          const rawSyrups = selections.syrupSelections || {};
          const syrupSels = Array.isArray(rawSyrups)
            ? rawSyrups
            : [...new Set(Object.values(rawSyrups).flat())];
          const adjustments = proposal.adjustments || [];

          // A total_price_override is a CONTRACT, not a catalog computation:
          // the engine's serviceTotal REPLACES the whole calculated total with
          // it. So we can neither drop it (the client's negotiated price
          // evaporates and they get billed at catalog, which overbilled Jack
          // Van Dyke by $627) nor pass it through untouched (the extras they
          // just bought become free). Price the delta at catalog with the
          // override OFF and move the contract by it. Anything this submit did
          // not change sits on both sides and cancels, including the CC-era
          // bundled first bar. Native proposals (no override) keep the plain
          // catalog recompute, unchanged.
          const hasOverride = proposal.total_price_override !== null
            && proposal.total_price_override !== undefined;
          let effectiveOverride = null;

          if (hasOverride) {
            const catalogArgs = {
              pkg,
              guestCount: proposal.guest_count,
              durationHours: Number(proposal.event_duration_hours),
              numBartenders: proposal.num_bartenders,
              adjustments,
              totalPriceOverride: null, // price the delta at CATALOG
              gratuityRate: proposal.gratuity_rate,
              tipJar: proposal.tip_jar,
            };
            const catalogBefore = calculateProposal({
              ...catalogArgs,
              numBars: numBarsAtIntent,
              addons: preAddonsRes.rows,
              syrupSelections: preSyrups,
            });
            const catalogAfter = calculateProposal({
              ...catalogArgs,
              numBars: proposal.num_bars ?? 0,
              addons: allAddonsRes.rows,
              syrupSelections: syrupSels,
            });
            const extrasDelta = Math.round((catalogAfter.total - catalogBefore.total) * 100) / 100;
            effectiveOverride = Math.round((Number(proposal.total_price_override) + extrasDelta) * 100) / 100;
          }

          const snapshot = calculateProposal({
            pkg,
            guestCount: proposal.guest_count,
            durationHours: Number(proposal.event_duration_hours),
            numBars: proposal.num_bars ?? 0,
            numBartenders: proposal.num_bartenders,
            addons: allAddonsRes.rows,
            syrupSelections: syrupSels,
            adjustments,
            totalPriceOverride: effectiveOverride,
            gratuityRate: proposal.gratuity_rate, tipJar: proposal.tip_jar, // §5 preserve stored gratuity
          });

          // Write the override alongside the total so the two can never drift
          // apart again (the stranded-column state that made Jack's row
          // inconsistent). For a native proposal effectiveOverride is null and
          // the column is already null, so this is a no-op there.
          await client.query(
            'UPDATE proposals SET total_price = $1, pricing_snapshot = $2, total_price_override = $4, updated_at = NOW() WHERE id = $3',
            [snapshot.total, JSON.stringify(snapshot), proposal.id, effectiveOverride]
          );
```

- [ ] **Step 3: Run the new suite and verify it passes**

Run: `node --test server/routes/drinkPlans/submitOverride.test.js`

Expected: all 5 tests PASS.

- [ ] **Step 4: Run the neighbouring submit suites for regressions**

Run one at a time (the suites share the dev DB):

```bash
node --test server/routes/drinkPlans/submitReconcile.test.js
node --test server/routes/drinkPlans/submitExtras.test.js
node --test server/utils/invoiceLifecycle.additionalInvoice.test.js
node --test server/utils/invoiceLifecycle.external.test.js
```

Expected: all PASS. `submitReconcile` is the important one: it seeds a native proposal with no override, so it proves the native path is untouched.

- [ ] **Step 5: Commit**

```bash
git add server/routes/drinkPlans/submit.js
git commit -m "fix(drink-plans): preserve negotiated price across a drink-plan submit

A client-submitted plan with a financial extra re-priced the proposal from
catalog, destroying total_price_override and stranding the column. Jack Van
Dyke's \$3,273 CC contract became \$4,000 and he was emailed a \$3,900 balance.

Passing the override through naively is NOT the fix: serviceTotal replaces the
calculated total, so every extra would become free. Instead price the delta at
catalog with the override off and move the contract by it. Anything the submit
did not change cancels, including the CC-era bundled first bar. Native
proposals keep the plain catalog recompute."
```

---

### Task 4: Full server suite

**Files:** none (verification only)

- [ ] **Step 1: Run the whole server suite**

Run: `npm test`

Expected: green. If a suite fails, confirm it fails identically on `main` before blaming this change (pay-period fixtures are chicago-keyed and some suites are known to be order-sensitive).

- [ ] **Step 2: Lint**

Run: `npm run lint`

Expected: no new errors in `server/routes/drinkPlans/submit.js`.

---

### Task 5: CC balance-invoice operator script

**Files:**
- Create: `scripts/cc-balance-invoice.js`
- Test: manual dry-run against the dev DB, then a Neon branch rehearsal before prod.

**Interfaces:**
- Consumes: `pool` from `server/db`.
- Produces: CLI only. No exports.

**Why a script:** `generateLineItemsFromProposal` is override-blind and stays that way (spec, Out of scope). The remaining CC balance invoices need a shape it cannot produce: label `Balance` (a real `CONTRACT_LABELS` member so refunds classify correctly), born `sent` (the draft-pay trap: the public page renders drafts but `create-intent-for-invoice` refuses them), line items reconciling to `amount_due`, and `locked` so `refreshUnlockedInvoices` cannot rebuild the itemization from catalog on the next admin save. This is a closing-chapter tool; delete it after Check Cherry is cancelled on 2026-07-21.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
'use strict';

/**
 * One-time operator script: mint the remaining Check Cherry balance invoices.
 *
 * Dry-run by default. Nothing is emailed, ever. Dallas writes those himself.
 *
 *   node scripts/cc-balance-invoice.js               # dry-run every eligible proposal
 *   node scripts/cc-balance-invoice.js --only 597    # dry-run one
 *   node scripts/cc-balance-invoice.js --only 597 --apply
 *
 * Produces the INV-0193 shape (Jack Van Dyke, minted by hand 2026-07-16):
 *   label 'Balance'   -> a real CONTRACT_LABELS member, so refundHelpers does
 *                        not classify the payment as extra-scope
 *   status 'sent'     -> the draft-pay trap: the public invoice page renders a
 *                        draft but create-intent-for-invoice refuses it
 *   locked = true     -> refreshUnlockedInvoices skips it, so an admin save
 *                        cannot rebuild the itemization from catalog
 *   line items summing exactly to amount_due, with the deposit as a credit line
 *
 * Delete this script once Check Cherry is cancelled (2026-07-21).
 */

require('dotenv').config();
const { pool } = require('../server/db');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx !== -1 ? parseInt(args[onlyIdx + 1], 10) : null;

const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

async function main() {
  const { rows } = await pool.query(
    `SELECT p.id, c.name AS client_name, p.event_date::date AS event_date,
            p.total_price, p.total_price_override, p.amount_paid, p.balance_due_date,
            sp.name AS package_name, p.event_duration_hours, p.guest_count,
            (SELECT COUNT(*)::int FROM invoices i WHERE i.proposal_id = p.id AND i.status <> 'void') AS live_invoices,
            (SELECT COUNT(*)::int FROM proposal_addons pa WHERE pa.proposal_id = p.id) AS addon_rows
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.transferred_from_cc_id IS NOT NULL
        AND p.status = 'confirmed'
        ${ONLY ? 'AND p.id = $1' : ''}
      ORDER BY p.balance_due_date NULLS LAST, p.id`,
    ONLY ? [ONLY] : []
  );

  if (rows.length === 0) {
    console.log('No transferred, confirmed proposals matched.');
    return;
  }

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${rows.length} candidate(s)\n`);
  let minted = 0;

  for (const r of rows) {
    const totalCents = Math.round(Number(r.total_price) * 100);
    const paidCents = Math.round(Number(r.amount_paid) * 100);
    const dueCents = totalCents - paidCents;
    const label = `#${r.id} ${r.client_name} (${r.event_date.toISOString().slice(0, 10)})`;

    // Guards. Each SKIP is a case that must be handled by hand, not silently.
    if (r.live_invoices > 0) { console.log(`SKIP ${label}: already has a non-void invoice`); continue; }
    if (dueCents <= 0) { console.log(`SKIP ${label}: nothing owed (${usd(dueCents)})`); continue; }
    if (r.total_price_override === null) { console.log(`SKIP ${label}: no contract override, use the normal invoice flow`); continue; }
    // total_price above the override means drink-plan extras were folded in.
    // The single contract line below would silently bury them, so refuse.
    if (Math.round(Number(r.total_price_override) * 100) !== totalCents) {
      console.log(`SKIP ${label}: total ${usd(totalCents)} != contract ${usd(Math.round(Number(r.total_price_override) * 100))}, extras folded in — handle by hand`);
      continue;
    }
    if (r.addon_rows > 0) { console.log(`SKIP ${label}: has ${r.addon_rows} add-on row(s) — handle by hand`); continue; }

    const lines = [
      { desc: `${r.package_name} (${Number(r.event_duration_hours)} hrs, ${r.guest_count} guests)`, cents: totalCents, src: 'package' },
    ];
    if (paidCents > 0) lines.push({ desc: 'Less deposit already paid', cents: -paidCents, src: 'manual' });

    const sum = lines.reduce((s, l) => s + l.cents, 0);
    if (sum !== dueCents) { console.log(`SKIP ${label}: lines ${usd(sum)} != amount due ${usd(dueCents)}`); continue; }

    console.log(`${APPLY ? 'MINT' : 'WOULD MINT'} ${label}`);
    for (const l of lines) console.log(`    ${l.desc.padEnd(48)} ${usd(l.cents).padStart(12)}`);
    console.log(`    ${'AMOUNT DUE'.padEnd(48)} ${usd(dueCents).padStart(12)}   due ${r.balance_due_date ? r.balance_due_date.toISOString().slice(0, 10) : 'n/a'}`);

    if (!APPLY) { console.log(''); continue; }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inv = (await client.query(
        `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, status, due_date, locked, locked_at)
         SELECT $1, 'INV-' || lpad(nextval('invoice_number_seq')::text, 4, '0'), 'Balance', $2, 'sent', $3, true, NOW()
          WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE proposal_id = $1 AND status <> 'void')
         RETURNING id, invoice_number, token`,
        [r.id, dueCents, r.balance_due_date]
      )).rows[0];
      if (!inv) { await client.query('ROLLBACK'); console.log('    RACE: an invoice appeared, skipped\n'); continue; }

      for (const l of lines) {
        await client.query(
          `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, line_total, source_type, source_id)
           VALUES ($1, $2, 1, $3, $3, $4, NULL)`,
          [inv.id, l.desc, l.cents, l.src]
        );
      }
      await client.query('COMMIT');
      minted += 1;
      console.log(`    ${inv.invoice_number}  https://drbartender.com/invoice/${inv.token}\n`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`    FAILED ${label}: ${e.message}\n`);
    } finally {
      client.release();
    }
  }

  console.log(APPLY ? `\nMinted ${minted} invoice(s). Nothing was emailed.` : '\nDry run. Re-run with --apply to write.');
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
```

- [ ] **Step 2: Dry-run against the dev DB**

Run: `node scripts/cc-balance-invoice.js`

Expected: it runs without throwing and prints either candidates or "No transferred, confirmed proposals matched." (dev has no CC transfers, so a clean empty result is a pass). The point of this step is to prove the SQL parses and the guards execute.

- [ ] **Step 3: Commit**

```bash
git add scripts/cc-balance-invoice.js
git commit -m "feat(scripts): one-time CC balance-invoice minter

Mints the INV-0193 shape the invoice generator cannot produce: label
'Balance', born 'sent' (draft-pay trap), lines reconciling to amount_due
with the deposit as a credit, and locked so an admin save cannot rebuild
the itemization from catalog. Dry-run default. Never emails.
Delete after CC is cancelled 2026-07-21."
```

---

### Task 6: Fix-list the deferred warts

**Files:**
- Modify: `docs/fix-list-remaining-2026-07-02.md`

- [ ] **Step 1: Append the two deferred items**

Add to the fix-list, matching the file's existing entry style:

```markdown
- **`generateLineItemsFromProposal` is override-blind.** Any proposal with a
  `total_price_override` that differs from catalog gets an invoice whose total is
  correct but whose line items do not match it (Shiralee INV-0120: $450 of lines on a
  $270 invoice). Pre-existing and cosmetic. Deliberately NOT fixed alongside the
  2026-07-16 drink-plan money fix: every invoice flows through that generator, and an
  honest reconciling line for the CC events would depend on the "bar included" fact that
  exists only in the 2024 contract PDFs. Affects native custom-priced proposals too.
- **The $50 first-bar ghost resurrects on recompute.** CC-transferred proposals carry
  `num_bars >= 1` where the contract bundles the bar, so any snapshot recompute re-adds
  the package's `first_bar_fee` to the breakdown. Demoted to cosmetic by the 2026-07-16
  fix (the override now always pins the total, so it can never reach a charge), but it
  still reappears as a breakdown line on the proposal page after each admin save.
```

- [ ] **Step 2: Commit**

```bash
git add docs/fix-list-remaining-2026-07-02.md
git commit -m "docs(fix-list): log the deferred override itemization + bar-ghost warts"
```

---

### Task 7: Merge the lane

**Files:** none

- [ ] **Step 1: Squash-merge back to main**

```bash
cd ~/projects/os
bash scripts/merge-lane.sh drink-plan-override
```

- [ ] **Step 2: Tear the lane down**

```bash
npm run worktree:rm drink-plan-override
```

- [ ] **Step 3: STOP. Do not push.**

This is a money path. The review fleet runs against the merged diff BEFORE any push, per CLAUDE.md's push model. Report the merged SHA and hand back to Dallas.

## Self-Review

**Spec coverage:**
- Rule `newOverride = oldOverride + catalogDelta` → Task 3 Step 2.
- The trap (naive pass-through makes extras free) → Task 2 assertion "the extra must actually be charged", Task 3 comment.
- Native path unchanged → Task 3 branch, Task 2 native test, Task 3 Step 4 (`submitReconcile` seeds a native proposal).
- Pre-extras reconstruction (numBars / addons / syrups) → Task 3 Step 1.
- Adjustments passed in both branches → Task 3 Step 2, Task 2 adjustments test.
- `computeExtrasBreakdown` rejected for the delta → spec rationale; the plan uses two engine calls.
- CC-era bundled bar cancels → Task 2 "first-bar fee never enters the delta" test.
- Operator script (label/sent/locked/reconciling lines/dry-run/no email) → Task 5.
- Out-of-scope items logged → Task 6.

**Placeholder scan:** none. Every code step carries complete code.

**Type consistency:** `effectiveOverride` (dollars, `number|null`) is the single name used in Task 3 and is what feeds both `calculateProposal({ totalPriceOverride })` and the UPDATE `$4`. `numBarsAtIntent` and `preAddonsRes` / `preSyrups` are defined in Task 3 Step 1 and consumed in Step 2. Script money is cents throughout (`totalCents`, `paidCents`, `dueCents`); proposal money is dollars and is converted once at read.
