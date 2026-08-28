# Deposit-to-Full Invoice Upgrade Implementation Plan (lane 2: full-pay-invoice)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client who pays in full on a deposit-terms proposal ends up with ONE invoice, `Full Payment`, at the amount they paid, paid and locked; the fourteen bookings already in the wrong shape are corrected; an invoice-link overflow reaches Dallas by email.

**Architecture:** One new lifecycle helper, `upgradeDepositInvoiceToFull(proposalId, dbClient)`, re-derives the open Deposit invoice from the proposal (label, amount, lines) inside the caller's transaction, before the payment is credited. The webhook and the admin record-payment route both call it when the payment is a full payment, so the two entrances cannot drift. The existing cap in `linkPaymentToInvoice` is untouched; it simply never overflows on this path any more. A one-off script with a dry run repairs the existing rows. `warnLinkAnomaly` gains an admin email for `overflow_capped`.

**Tech Stack:** Node/Express, pg via `server/db`, node:test, the existing invoice lifecycle helpers (`createInvoice`, `generateLineItemsFromProposal`, `writeLineItems`, `linkPaymentToInvoice`).

**Spec:** `docs/superpowers/specs/2026-08-28-post-payment-settle-and-full-pay-invoice-design.md`, sections 1b, 2 (decisions 2, 3, 4, 5), 4, 5, 6 (lane 2), 7.

## Global Constraints

- `proposals.*` money is DOLLARS (numeric strings from pg). `invoices.*`, `invoice_payments.amount`, `proposal_payments.amount` and Stripe are integer CENTS. `toCents()` from `server/utils/invoiceShared` is the ONE crossing.
- Server tests: from the repo root, one file at a time, `node --test <path>`. Every test file starts with `require('dotenv').config();` and refuses to run when `NODE_ENV === 'production'`. Read the pass count; a suite that reports 0 tests did not run. Server tests share the dev database; clean up every row you create, in dependency order.
- The dev box talks to LIVE Stripe by design. Nothing in this lane calls Stripe. Do not add a Stripe call to a test.
- Commit with explicit pathspecs (`git add <files>`), never `git add -A`. Commit messages via `git commit -F - <<'MSG'` and never contain backticks.
- Work happens in worktree lane `full-pay-invoice` off `main`. Do not run `npm install` inside the lane.
- This lane is money and webhook: review is the full pre-prod fleet plus `/second-opinion` before merge (spec §7). The push cue gates the push, never the review.
- The backfill script runs against prod only after this lane is live on main, dry run first, Dallas reads the fourteen lines, then `--apply`.
- No em dashes in prose written into docs or client-facing strings. The admin email body in Task 4 is prose; keep it dash-free.

---

### Task 1: `upgradeDepositInvoiceToFull`, the helper

**Files:**
- Modify: `server/utils/invoiceLifecycle.js` (add the function before `module.exports`, export it)
- Modify: `server/utils/invoiceHelpers.js` (re-export it, both in the destructuring `require('./invoiceLifecycle')` block and in `module.exports`)
- Test: `server/utils/invoiceLifecycle.upgrade.test.js`

**Interfaces:**
- Produces: `upgradeDepositInvoiceToFull(proposalId: number, dbClient?: PoolClient): Promise<invoiceRow | null>`. Returns the updated `invoices` row when an open Deposit invoice was re-derived, `null` when nothing qualified. Writes `proposal_activity_log` action `invoice_upgraded_to_full`.

- [ ] **Step 1: Write the failing test**

```js
// server/utils/invoiceLifecycle.upgrade.test.js
// The deposit-to-full upgrade (spec 2026-08-28 §4a). A deposit-terms send
// mints a Deposit invoice; when the client pays in FULL the open Deposit row
// is re-derived from the proposal into the Full Payment invoice BEFORE the
// credit lands, so the payment fits and nothing overflows. Guard cases pin
// that a Deposit with money on it, a locked one, a void one, or a differently
// labelled one is never touched.
require('dotenv').config();

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { upgradeDepositInvoiceToFull } = require('./invoiceLifecycle');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoiceLifecycle.upgrade.test.js refuses to run against production');
}

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
let seq = 0;
const clientIds = [];
const proposalIds = [];
const invoiceIds = [];

async function seed({ label = 'Deposit', status = 'sent', locked = false, invoiceAmountPaid = 0, totalPrice = 550, externalPaid = 0 } = {}) {
  seq += 1;
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Upgrade Test', $1) RETURNING id`,
    [`upg-${NONCE}-${seq}@example.test`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, external_paid,
                            pricing_snapshot, event_date, event_start_time, event_duration_hours, event_type, payment_type)
     VALUES ($1, 'accepted', $2, 0, 100, $3,
             '{"package": {"name": "The Core Reaction", "base_cost": 350}, "total": 550}'::jsonb,
             CURRENT_DATE + INTERVAL '30 days', '6:00 PM', 4, 'Cocktail Party', 'full')
     RETURNING id`,
    [c.rows[0].id, totalPrice, externalPaid]
  );
  proposalIds.push(p.rows[0].id);
  const i = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked, due_date)
     VALUES ($1, $2, $3, 10000, $4, $5, $6, CURRENT_DATE + INTERVAL '10 days') RETURNING id`,
    [p.rows[0].id, `UPG${NONCE}${seq}`, label, invoiceAmountPaid, status, locked]
  );
  invoiceIds.push(i.rows[0].id);
  return { proposalId: p.rows[0].id, invoiceId: i.rows[0].id };
}

const invoice = async (id) => (await pool.query('SELECT * FROM invoices WHERE id = $1', [id])).rows[0];
const breadcrumbs = async (proposalId) => (await pool.query(
  "SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'invoice_upgraded_to_full'", [proposalId]
)).rows;

after(async () => {
  if (invoiceIds.length) {
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id = ANY($1::int[])', [invoiceIds]);
    await pool.query('DELETE FROM invoices WHERE id = ANY($1::int[])', [invoiceIds]);
  }
  if (proposalIds.length) {
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('happy path: the open Deposit becomes Full Payment at total_price, lines regenerate, breadcrumb written', async () => {
  const { proposalId, invoiceId } = await seed();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await upgradeDepositInvoiceToFull(proposalId, client);
    await client.query('COMMIT');
    assert.ok(out, 'returns the updated row');
    assert.equal(out.id, invoiceId);
  } finally {
    client.release();
  }
  const inv = await invoice(invoiceId);
  assert.equal(inv.label, 'Full Payment');
  assert.equal(Number(inv.amount_due), 55000);
  assert.equal(Number(inv.amount_paid), 0, 'no money moved; that is the link step');
  assert.equal(inv.status, 'sent');
  assert.equal(inv.locked, false);
  assert.equal(inv.due_date, null);
  assert.equal(inv.invoice_number, `UPG${NONCE}1`, 'the invoice number never changes');
  const lines = (await pool.query('SELECT description, line_total FROM invoice_line_items WHERE invoice_id = $1', [invoiceId])).rows;
  assert.ok(lines.length >= 1, 'lines regenerated from the snapshot');
  assert.equal(lines[0].description, 'The Core Reaction');
  const bc = await breadcrumbs(proposalId);
  assert.equal(bc.length, 1);
  assert.equal(bc[0].details.invoice_id, invoiceId);
  assert.equal(bc[0].details.from_amount_due, 10000);
  assert.equal(bc[0].details.to_amount_due, 55000);
});

test('external_paid is netted out of the re-derived amount', async () => {
  const { proposalId, invoiceId } = await seed({ externalPaid: 100 });
  await upgradeDepositInvoiceToFull(proposalId);
  assert.equal(Number((await invoice(invoiceId)).amount_due), 45000);
});

test('guard: a Deposit with money on it is never touched', async () => {
  const { proposalId, invoiceId } = await seed({ status: 'partially_paid', invoiceAmountPaid: 5000 });
  assert.equal(await upgradeDepositInvoiceToFull(proposalId), null);
  assert.equal((await invoice(invoiceId)).label, 'Deposit');
  assert.equal((await breadcrumbs(proposalId)).length, 0);
});

test('guard: a locked Deposit is never touched', async () => {
  const { proposalId, invoiceId } = await seed({ locked: true });
  assert.equal(await upgradeDepositInvoiceToFull(proposalId), null);
  assert.equal((await invoice(invoiceId)).label, 'Deposit');
});

test('guard: a void Deposit is never touched', async () => {
  const { proposalId, invoiceId } = await seed({ status: 'void' });
  assert.equal(await upgradeDepositInvoiceToFull(proposalId), null);
  assert.equal((await invoice(invoiceId)).label, 'Deposit');
});

test('guard: a Balance or Full Payment invoice is not a Deposit', async () => {
  const b = await seed({ label: 'Balance' });
  assert.equal(await upgradeDepositInvoiceToFull(b.proposalId), null);
  assert.equal((await invoice(b.invoiceId)).label, 'Balance');
  const f = await seed({ label: 'Full Payment' });
  assert.equal(await upgradeDepositInvoiceToFull(f.proposalId), null);
});

test('guard: a proposal with no invoice at all returns null', async () => {
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ('Upgrade Test', $1) RETURNING id`, [`upg-none-${NONCE}@example.test`]);
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, event_date, event_start_time, event_duration_hours, event_type)
     VALUES ($1, 'accepted', 550, 0, 100, CURRENT_DATE + INTERVAL '30 days', '6:00 PM', 4, 'Cocktail Party') RETURNING id`,
    [c.rows[0].id]
  );
  proposalIds.push(p.rows[0].id);
  assert.equal(await upgradeDepositInvoiceToFull(p.rows[0].id), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from repo root): `node --test server/utils/invoiceLifecycle.upgrade.test.js`
Expected: FAIL, `upgradeDepositInvoiceToFull is not a function` on every test. Summary shows `fail 7`.

- [ ] **Step 3: Write the helper**

In `server/utils/invoiceLifecycle.js`, directly above `module.exports = {`, add:

```js
// ─── 11. upgradeDepositInvoiceToFull ─────────────────────────────────────────

/**
 * The deposit-to-full upgrade (spec 2026-08-28 §4a). createInvoiceOnSend
 * mints the first invoice from payment_type AT SEND TIME (column default
 * 'deposit'), so a client who then picks pay-in-full at checkout arrives with
 * a $100 Deposit invoice open and a full-total payment landing. The label-blind
 * link then credits $100 and drops the rest (linkPaymentToInvoice's cap is
 * correct and stays; it is the seam-sweep M1/M2/L2 guard).
 *
 * Applied rule (2026-07-28 post-mortem): the proposal wins. Re-derive the open
 * Deposit row FROM the proposal, in the caller's transaction, BEFORE the
 * credit: label Full Payment, amount_due = total_price − external_paid (the
 * same formula a full-terms send uses), due_date cleared, lines regenerated.
 * The invoice number does not change. Guarded to an unlocked, unpaid, 'sent'
 * Deposit: anything with money on it, locked, void, or differently labelled
 * is never touched and null comes back.
 *
 * Callers: the payment_intent.succeeded webhook and the admin record-payment
 * route, both only when the payment is a full payment.
 *
 * @param {number} proposalId
 * @param {object} [dbClient]  transaction client; pool fallback for scripts/tests
 * @returns {Promise<object|null>} the updated invoice row, or null
 */
async function upgradeDepositInvoiceToFull(proposalId, dbClient) {
  const client = db(dbClient);

  const inv = await client.query(
    `SELECT id, invoice_number, amount_due
       FROM invoices
      WHERE proposal_id = $1 AND label = 'Deposit' AND status = 'sent'
        AND locked = false AND amount_paid = 0
      ORDER BY id ASC LIMIT 1
      FOR UPDATE`,
    [proposalId]
  );
  if (!inv.rows[0]) return null;
  const target = inv.rows[0];

  const prop = await client.query(
    'SELECT total_price, external_paid FROM proposals WHERE id = $1',
    [proposalId]
  );
  if (!prop.rows[0]) return null;
  const amountDueCents = Math.max(
    0, toCents(prop.rows[0].total_price) - toCents(prop.rows[0].external_paid)
  );

  const upd = await client.query(
    `UPDATE invoices
        SET label = 'Full Payment', amount_due = $1, due_date = NULL
      WHERE id = $2
      RETURNING *`,
    [amountDueCents, target.id]
  );

  const lineItems = await generateLineItemsFromProposal(proposalId, client);
  await writeLineItems(target.id, lineItems, client);

  await client.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
     VALUES ($1, 'invoice_upgraded_to_full', 'system', $2)`,
    [proposalId, JSON.stringify({
      invoice_id: target.id,
      invoice_number: target.invoice_number,
      from_amount_due: Number(target.amount_due),
      to_amount_due: amountDueCents,
    })]
  );

  return upd.rows[0];
}
```

Add `upgradeDepositInvoiceToFull,` to the `module.exports` object in `invoiceLifecycle.js` (after `findOpenInvoiceForBalance,`).

In `server/utils/invoiceHelpers.js`, add `upgradeDepositInvoiceToFull,` to the destructuring block `= require('./invoiceLifecycle');` (after `findOpenInvoiceForBalance,`) AND to the `module.exports` object (after `createAdditionalInvoiceIfNeeded,`).

- [ ] **Step 4: Run the test to verify it passes**

Run (from repo root): `node --test server/utils/invoiceLifecycle.upgrade.test.js`
Expected: `pass 7`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/utils/invoiceLifecycle.js server/utils/invoiceHelpers.js server/utils/invoiceLifecycle.upgrade.test.js
git commit -F - <<'MSG'
feat(invoices): upgradeDepositInvoiceToFull re-derives the open Deposit before a full payment lands

A deposit-terms send mints a Deposit invoice; a client who then pays in full
arrived with that row open and a full-total payment landing on it, so the
cap credited 100 dollars and dropped the rest. The proposal wins: re-derive
the open Deposit from the proposal into the Full Payment invoice, in the
caller's transaction, before the credit. Guarded to an unlocked, unpaid,
sent Deposit; everything else returns null and is never touched.
MSG
```

---

### Task 2: The webhook calls it on a full payment

**Files:**
- Modify: `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js` (the label-blind fallback branch, currently lines 590 to 609; and the invoiceHelpers require on line 10)
- Test: `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.fullOnDeposit.test.js`

**Interfaces:**
- Consumes: `upgradeDepositInvoiceToFull` via `require('../../utils/invoiceHelpers')` (Task 1).

- [ ] **Step 1: Write the failing test**

```js
// server/routes/stripeWebhookHandlers/paymentIntentSucceeded.fullOnDeposit.test.js
// A FULL payment on a deposit-terms proposal (spec 2026-08-28 §4b). Before
// this lane the webhook credited 100 dollars of a 550 dollar capture onto the
// send-time Deposit invoice and dropped 450 into a Sentry warning. Afterwards
// there is exactly one contract invoice, Full Payment, at the capture amount,
// paid and locked, and the link overflows nothing. A DEPOSIT payment on the
// same shape is pinned unchanged: Deposit paid plus a Balance invoice minted.
//
// Calls the handler function DIRECTLY with a synthetic event (no Stripe
// signature, no Stripe call). Post-commit side effects that are not under
// test are stubbed on the shared module exports BEFORE the handler is
// required, because the handler destructures them at require time.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
process.env.SENTRY_DSN_SERVER = '';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('paymentIntentSucceeded.fullOnDeposit.test.js refuses to run against production');
}

require('../../utils/email').sendEmail = async () => ({ skipped: true });
require('../../utils/adminNotifications').notifyAdminCategory = async () => ({ emailed: 0, texted: 0 });
require('../../utils/eventCreation').createEventShifts = async () => null;
require('../../utils/marketingHandlers').onProposalSignedAndPaid = async () => {};
require('../../utils/marketingHandlers').cancelMarketingForProposal = async () => {};
require('../../utils/depositPaidSchedulers').scheduleDepositPaidReminders = async () => {};
require('../../utils/stripePaymentNotifications').sendPaymentNotifications = async () => {};
require('../../utils/lastMinuteAlert').notifyLastMinuteBooking = () => {};

const handlePaymentIntentSucceeded = require('./paymentIntentSucceeded');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
let seq = 0;
const clientIds = [];
const proposalIds = [];

// Capture console.warn so the overflow_capped anomaly (which only console.warns
// when SENTRY_DSN_SERVER is empty) is observable.
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };

async function seed({ paymentType }) {
  seq += 1;
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Full On Deposit', $1) RETURNING id`,
    [`fod-${NONCE}-${seq}@example.test`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, external_paid,
                            pricing_snapshot, event_date, event_start_time, event_duration_hours,
                            event_type, payment_type, client_signed_at, balance_due_date)
     VALUES ($1, 'accepted', 550, 0, 100, 0,
             '{"package": {"name": "The Core Reaction", "base_cost": 350}, "total": 550}'::jsonb,
             CURRENT_DATE + INTERVAL '30 days', '6:00 PM', 4, 'Cocktail Party', $2, NOW(),
             CURRENT_DATE + INTERVAL '16 days')
     RETURNING id`,
    [c.rows[0].id, paymentType]
  );
  proposalIds.push(p.rows[0].id);
  // The send-time Deposit invoice: what createInvoiceOnSend mints on a
  // deposit-terms send.
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Deposit', 10000, 0, 'sent', false)`,
    [p.rows[0].id, `FOD${NONCE}${seq}`]
  );
  return p.rows[0].id;
}

function event({ proposalId, paymentType, amountCents }) {
  return {
    data: {
      object: {
        id: `pi_test_${NONCE}_${seq}`,
        amount: amountCents,
        payment_method: null,
        metadata: { proposal_id: String(proposalId), payment_type: paymentType },
      },
    },
  };
}

const contractInvoices = async (proposalId) => (await pool.query(
  `SELECT id, label, amount_due, amount_paid, status, locked FROM invoices
    WHERE proposal_id = $1 AND status <> 'void' AND label IN ('Deposit', 'Balance', 'Full Payment')
    ORDER BY id`, [proposalId]
)).rows;

after(async () => {
  console.warn = realWarn;
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM scheduled_messages WHERE entity_type = $1 AND entity_id = ANY($2::int[])', ['proposal', ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('a FULL payment on deposit terms ends with one Full Payment invoice at the capture, paid, locked, no overflow', async () => {
  const proposalId = await seed({ paymentType: 'full' });
  warnings.length = 0;
  await handlePaymentIntentSucceeded(event({ proposalId, paymentType: 'full', amountCents: 55000 }));

  const invs = await contractInvoices(proposalId);
  assert.equal(invs.length, 1, `expected one contract invoice, got ${JSON.stringify(invs)}`);
  assert.equal(invs[0].label, 'Full Payment');
  assert.equal(Number(invs[0].amount_due), 55000);
  assert.equal(Number(invs[0].amount_paid), 55000);
  assert.equal(invs[0].status, 'paid');
  assert.equal(invs[0].locked, true);

  const link = (await pool.query('SELECT amount FROM invoice_payments WHERE invoice_id = $1', [invs[0].id])).rows;
  assert.equal(link.length, 1);
  assert.equal(Number(link[0].amount), 55000);

  const prop = (await pool.query('SELECT status, amount_paid FROM proposals WHERE id = $1', [proposalId])).rows[0];
  assert.equal(prop.status, 'balance_paid');
  assert.equal(Number(prop.amount_paid), 550);

  const bc = (await pool.query(
    "SELECT 1 FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'invoice_upgraded_to_full'", [proposalId]
  )).rowCount;
  assert.equal(bc, 1, 'one upgrade breadcrumb');

  assert.equal(warnings.filter((w) => w.includes('overflow_capped')).length, 0, `overflow warned: ${warnings.join(' | ')}`);
});

test('a DEPOSIT payment on the same shape is unchanged: Deposit paid, Balance minted, no upgrade', async () => {
  const proposalId = await seed({ paymentType: 'deposit' });
  await handlePaymentIntentSucceeded(event({ proposalId, paymentType: 'deposit', amountCents: 10000 }));

  const invs = await contractInvoices(proposalId);
  assert.equal(invs.length, 2, JSON.stringify(invs));
  const dep = invs.find((i) => i.label === 'Deposit');
  const bal = invs.find((i) => i.label === 'Balance');
  assert.ok(dep && bal, 'Deposit and Balance both present');
  assert.equal(Number(dep.amount_paid), 10000);
  assert.equal(dep.status, 'paid');
  assert.equal(dep.locked, true);
  assert.equal(Number(bal.amount_due), 45000);
  assert.equal(bal.status, 'sent');

  const bc = (await pool.query(
    "SELECT 1 FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'invoice_upgraded_to_full'", [proposalId]
  )).rowCount;
  assert.equal(bc, 0, 'a deposit never upgrades');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from repo root): `node --test server/routes/stripeWebhookHandlers/paymentIntentSucceeded.fullOnDeposit.test.js`
Expected: test 1 FAILS on `label`: `'Deposit' !== 'Full Payment'` (the capped credit lands on the Deposit row today), and `overflow warned: ... overflow_capped ...` if the label assertion is removed. Test 2 PASSES (it pins today's deposit behaviour). Summary `pass 1`, `fail 1`.

- [ ] **Step 3: Add the call in the webhook**

In `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js`, on line 10, add `upgradeDepositInvoiceToFull` to the destructuring from `'../../utils/invoiceHelpers'`:

```js
const { createInvoiceOnSend, createBalanceInvoice, linkPaymentToInvoice, createDrinkPlanExtrasInvoice, findExtrasInvoice, findOpenInvoiceForBalance, upgradeDepositInvoiceToFull } = require('../../utils/invoiceHelpers');
```

In the label-blind fallback branch, directly above the line `const openInvoice = await dbClient.query(` (the one whose query begins `SELECT id FROM invoices` with `AND NOT (label = ANY($2::text[]))`), insert:

```js
              // Deposit-to-full upgrade (spec 2026-08-28 §4b). A full payment
              // on a deposit-terms proposal arrives with the send-time Deposit
              // invoice open. Re-derive it into the Full Payment invoice NOW,
              // in this transaction, so the link below fits the whole capture
              // instead of crediting $100 and overflowing the rest. The
              // gratuity election was applied to total_price above, so the
              // helper reads the final total. No-op (null) for anything but an
              // unlocked, unpaid, sent Deposit.
              if (paymentType === 'full') {
                await upgradeDepositInvoiceToFull(proposalId, dbClient);
              }
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from repo root): `node --test server/routes/stripeWebhookHandlers/paymentIntentSucceeded.fullOnDeposit.test.js`
Expected: `pass 2`, `fail 0`.

- [ ] **Step 5: Run the sibling webhook suites, one at a time**

Run: `node --test server/routes/stripeWebhookHandlers/paymentIntentSucceeded.extension.test.js` then `node --test server/routes/stripeWebhookHandlers/checkoutSessionCompleted.lastMinute.test.js`
Expected: each reports its full pass count and `fail 0`. Note the counts in the commit message.

- [ ] **Step 6: Commit**

```bash
git add server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js server/routes/stripeWebhookHandlers/paymentIntentSucceeded.fullOnDeposit.test.js
git commit -F - <<'MSG'
fix(webhook): a full payment on deposit terms upgrades the Deposit invoice before the credit

Fourteen bookings since July carry a paid 100 dollar Deposit invoice and no
invoice at all behind the rest of the money, because the label-blind link
credited the capture onto the send-time Deposit row and the cap dropped the
overflow into a Sentry warning. The webhook now re-derives that row into the
Full Payment invoice inside its transaction, after the gratuity apply and
before the link, so the whole capture fits. A deposit payment is pinned
unchanged: Deposit paid, Balance minted.
MSG
```

---

### Task 3: The admin record-payment route calls it on paid-in-full

**Files:**
- Modify: `server/routes/proposals/actions.js` (line 23 require; the `record-payment` handler's link block, currently lines 287 to 301)
- Test: `server/routes/proposals/recordPayment.fullOnDeposit.test.js`

**Interfaces:**
- Consumes: `upgradeDepositInvoiceToFull` via `require('../../utils/invoiceHelpers')` (Task 1).

- [ ] **Step 1: Write the failing test**

```js
// server/routes/proposals/recordPayment.fullOnDeposit.test.js
// The admin door to the same hole the webhook had (spec 2026-08-28 §4c, seam
// sweep L2): recording paid_in_full on a deposit-terms proposal linked the
// capped 100 dollars onto the Deposit invoice and left the rest with no
// invoice. Same helper as the webhook, so the two entrances cannot drift.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');

if (process.env.NODE_ENV === 'production') {
  throw new Error('recordPayment.fullOnDeposit.test.js refuses to run against production');
}

require('../../utils/email').sendEmail = async () => ({ skipped: true });
require('../../utils/adminNotifications').notifyAdminCategory = async () => {};
require('../../utils/eventCreation').createEventShifts = async () => null;
require('../../utils/marketingHandlers').onProposalSignedAndPaid = async () => {};

const actionsRouter = require('./actions');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
let server, baseUrl, adminId, adminToken, clientId, proposalId, invoiceId;

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id`,
    [`recpay-fod-${NONCE}-admin@example.test`]
  );
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const c = await pool.query(
    `INSERT INTO clients (name, email, email_status) VALUES ('Record Full On Deposit', $1, 'ok') RETURNING id`,
    [`recpay-fod-${NONCE}@example.test`]
  );
  clientId = c.rows[0].id;

  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours,
                            total_price, amount_paid, deposit_amount, external_paid, pricing_snapshot, payment_type)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'accepted', 'Cocktail Party', '6:00 PM', 4,
             550, 0, 100, 0, '{"package": {"name": "The Core Reaction", "base_cost": 350}, "total": 550}'::jsonb, 'deposit')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  const i = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Deposit', 10000, 0, 'sent', false) RETURNING id`,
    [proposalId, `RFD${NONCE}`]
  );
  invoiceId = i.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', actionsRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (proposalId) {
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = $1)', [proposalId]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = $1)', [proposalId]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  if (adminId) await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await pool.end();
});

function postJson(path, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${token}` };
    const r = http.request({ method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname, headers }, (res) => {
      let buf = '';
      res.on('data', (ch) => { buf += ch; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

test('recording paid_in_full on deposit terms ends with one Full Payment invoice at the total, paid, locked', async () => {
  const r = await postJson(`/api/proposals/${proposalId}/record-payment`, adminToken, { paid_in_full: true, method: 'check' });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.body}`);

  const invs = (await pool.query(
    `SELECT id, label, amount_due, amount_paid, status, locked FROM invoices
      WHERE proposal_id = $1 AND status <> 'void' ORDER BY id`, [proposalId]
  )).rows;
  assert.equal(invs.length, 1, JSON.stringify(invs));
  assert.equal(invs[0].id, invoiceId, 'the same row, re-derived, not a new one');
  assert.equal(invs[0].label, 'Full Payment');
  assert.equal(Number(invs[0].amount_due), 55000);
  assert.equal(Number(invs[0].amount_paid), 55000);
  assert.equal(invs[0].status, 'paid');
  assert.equal(invs[0].locked, true);

  const link = (await pool.query('SELECT amount FROM invoice_payments WHERE invoice_id = $1', [invoiceId])).rows;
  assert.equal(link.length, 1);
  assert.equal(Number(link[0].amount), 55000);

  const prop = (await pool.query('SELECT status, amount_paid FROM proposals WHERE id = $1', [proposalId])).rows[0];
  assert.equal(prop.status, 'balance_paid');
  assert.equal(Number(prop.amount_paid), 550);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from repo root): `node --test server/routes/proposals/recordPayment.fullOnDeposit.test.js`
Expected: FAIL on `label`: `'Deposit' !== 'Full Payment'`. Summary `fail 1`.

- [ ] **Step 3: Add the call in the route**

In `server/routes/proposals/actions.js` line 23, add the helper to the existing destructuring:

```js
const { linkPaymentToInvoice, createInvoiceOnSend, upgradeDepositInvoiceToFull } = require('../../utils/invoiceHelpers');
```

In the `record-payment` handler, directly above the comment `// Link payment to the oldest open invoice`, insert:

```js
    // Deposit-to-full upgrade (spec 2026-08-28 §4c): the admin door to the
    // same seam the webhook has. A paid_in_full record on a deposit-terms
    // proposal must re-derive the open Deposit invoice into Full Payment
    // before the link below, or the capped credit lands on a $100 row and
    // the rest of the money has no invoice behind it. Same helper as the
    // webhook, so the two entrances cannot drift. No-op unless an unlocked,
    // unpaid, sent Deposit exists.
    if (isFullyPaid) {
      await upgradeDepositInvoiceToFull(proposal.id, dbClient);
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from repo root): `node --test server/routes/proposals/recordPayment.fullOnDeposit.test.js`
Expected: `pass 1`, `fail 0`.

- [ ] **Step 5: Run the sibling record-payment suites, one at a time**

Run: `node --test server/routes/proposals/recordPayment.invoiceCap.test.js` then `node --test server/routes/proposals/recordPayment.statusGuard.test.js` then `node --test server/routes/proposals/notifyClient.test.js`
Expected: each reports its full pass count and `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add server/routes/proposals/actions.js server/routes/proposals/recordPayment.fullOnDeposit.test.js
git commit -F - <<'MSG'
fix(record-payment): paid_in_full on deposit terms upgrades the Deposit invoice before the link

The admin door to the seam the webhook had (seam sweep L2). Same helper, so
the two entrances cannot drift.
MSG
```

---

### Task 4: The overflow anomaly emails Dallas

**Files:**
- Modify: `server/utils/invoiceLinking.js` (`warnLinkAnomaly`, and the `SELECT ... FOR UPDATE` plus the `overflow_capped` call inside `linkPaymentToInvoice`)
- Test: `server/utils/invoiceLinking.overflowAlert.test.js`

**Interfaces:**
- Consumes: `notifyAdminCategory({ category, subject, emailHtml, emailText })` from `server/utils/adminNotifications` (lazy-required inside the warn, to keep `invoiceLinking`'s import graph flat; `adminNotifications` pulls in email and SMS).
- Produces: on `overflow_capped`, one `notifyAdminCategory` call on category `payment_failure`, email only (no `smsBody`), fire-and-forget.

- [ ] **Step 1: Write the failing test**

```js
// server/utils/invoiceLinking.overflowAlert.test.js
// spec 2026-08-28 §4d: the overflow warning reaches Dallas by email, not only
// Sentry. Five silent fires in 28 days is how the Deposit-absorbs-full-payment
// defect stayed hidden. After Task 2 an overflow on the webhook path should be
// impossible, so this email means something new.
require('dotenv').config();
process.env.SENTRY_DSN_SERVER = '';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoiceLinking.overflowAlert.test.js refuses to run against production');
}

const notifyCalls = [];
require('./adminNotifications').notifyAdminCategory = async (args) => { notifyCalls.push(args); return { emailed: 1, texted: 0 }; };
const realWarn = console.warn;
console.warn = () => {};

const { linkPaymentToInvoice } = require('./invoiceLinking');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
let clientId, proposalId, invoiceId, paymentId;

after(async () => {
  console.warn = realWarn;
  if (invoiceId) await pool.query('DELETE FROM invoice_payments WHERE invoice_id = $1', [invoiceId]);
  if (invoiceId) await pool.query('DELETE FROM invoices WHERE id = $1', [invoiceId]);
  if (proposalId) {
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('an overflowing link credits the cap, records the cap, and emails the money-anomaly lane once', async () => {
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ('Overflow Alert', $1) RETURNING id`, [`ovf-${NONCE}@example.test`]);
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, event_date, event_start_time, event_duration_hours, event_type)
     VALUES ($1, 'accepted', 550, 550, 100, CURRENT_DATE + INTERVAL '30 days', '6:00 PM', 4, 'Cocktail Party') RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  const i = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Deposit', 10000, 0, 'sent', false) RETURNING id`,
    [proposalId, `OVF${NONCE}`]
  );
  invoiceId = i.rows[0].id;
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status) VALUES ($1, 'full', 55000, 'succeeded') RETURNING id`,
    [proposalId]
  );
  paymentId = pay.rows[0].id;

  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await linkPaymentToInvoice(invoiceId, paymentId, 55000, client);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  assert.equal(result.linked, true);
  assert.equal(result.creditedCents, 10000);
  assert.equal(result.overflowCents, 45000);

  assert.equal(notifyCalls.length, 1, 'exactly one admin notification');
  const call = notifyCalls[0];
  assert.equal(call.category, 'payment_failure');
  assert.ok(call.subject.includes(`#${proposalId}`), `subject names the proposal: ${call.subject}`);
  assert.ok(call.emailText.includes('$450.00'), `text names the dropped amount: ${call.emailText}`);
  assert.ok(call.emailText.includes('$100.00'), `text names the credited amount: ${call.emailText}`);
  assert.equal(call.smsBody, undefined, 'email only; SMS costs money');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from repo root): `node --test server/utils/invoiceLinking.overflowAlert.test.js`
Expected: FAIL at `notifyCalls.length`: `0 !== 1`.

- [ ] **Step 3: Add the email**

In `server/utils/invoiceLinking.js`, replace the whole `warnLinkAnomaly` function with:

```js
/**
 * Report an invoice-link anomaly loudly (console + Sentry) without throwing.
 * The proposal-side payment row is always recorded by callers, so money is
 * never lost when a link is refused; the alert is how the admin finds out.
 *
 * overflow_capped ALSO emails the money-anomaly lane (spec 2026-08-28 §4d):
 * it fired five times in 28 days into Sentry alone while fourteen bookings
 * quietly lost their invoice backing. After the deposit-to-full upgrade an
 * overflow on the contract path should be impossible, so this email means
 * something new. Email only, fire-and-forget, own catch: a notification
 * failure must never touch the link.
 */
function warnLinkAnomaly(kind, details) {
  console.warn(`linkPaymentToInvoice ${kind}:`, JSON.stringify(details));
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage(`invoice_link_${kind}`, {
      level: 'warning',
      tags: { util: 'invoiceHelpers', step: 'linkPaymentToInvoice' },
      extra: details,
    });
  }
  if (kind === 'overflow_capped') {
    // Lazy: adminNotifications pulls in email + SMS; keep this module's
    // import graph flat (invoiceHelpers is required nearly everywhere).
    const { notifyAdminCategory } = require('./adminNotifications');
    const d = details || {};
    const dollars = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
    const text =
      `A payment of ${dollars(d.amountCents)} landed on invoice ${d.invoiceId} `
      + `(proposal #${d.proposalId}), which had only ${dollars(d.remainingCents)} remaining. `
      + `${dollars(d.creditCents)} was credited to the invoice and ${dollars(d.overflowCents)} `
      + `has no invoice behind it. Payment row ${d.paymentId}. The proposal ledger is correct; `
      + `the invoice sub-ledger is short by that amount.`;
    notifyAdminCategory({
      category: 'payment_failure',
      subject: `Invoice link overflow on proposal #${d.proposalId}`,
      emailText: text,
      emailHtml: `<p>${text}</p>`,
    }).catch((err) => {
      console.error('overflow_capped admin notify failed (non-blocking):', err && err.message);
    });
  }
}
```

In `linkPaymentToInvoice`, change the first query to also select `proposal_id`:

```js
  const invRes = await dbClient.query(
    'SELECT proposal_id, status, amount_due, amount_paid FROM invoices WHERE id = $1 FOR UPDATE',
    [invoiceId]
  );
```

And change the overflow call to carry the proposal and the remaining figure:

```js
  if (overflowCents > 0) {
    warnLinkAnomaly('overflow_capped', {
      invoiceId, proposalId: inv.proposal_id, paymentId, amountCents, remainingCents, creditCents, overflowCents,
    });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from repo root): `node --test server/utils/invoiceLinking.overflowAlert.test.js`
Expected: `pass 1`, `fail 0`.

- [ ] **Step 5: Run the suites that reach `linkPaymentToInvoice`, one at a time**

Run: `node --test server/routes/proposals/recordPayment.invoiceCap.test.js` then `node --test server/routes/stripeWebhookHandlers/paymentIntentSucceeded.fullOnDeposit.test.js` then `node --test server/routes/stripeWebhookHandlers/paymentIntentSucceeded.extension.test.js`
Expected: each `fail 0`. (`invoiceCap` exercises the overflow path deliberately; it stubs `notifyAdminCategory` already, so the new email is a no-op there.)

- [ ] **Step 6: Commit**

```bash
git add server/utils/invoiceLinking.js server/utils/invoiceLinking.overflowAlert.test.js
git commit -F - <<'MSG'
feat(invoices): an invoice-link overflow emails the money-anomaly lane

It fired five times in 28 days into Sentry alone while fourteen bookings
lost their invoice backing. Email only, fire-and-forget, own catch.
MSG
```

---

### Task 5: The backfill script

**Files:**
- Create: `scripts/backfill-full-payment-invoices.js`
- Test: `scripts/backfill-full-payment-invoices.test.js`

**Interfaces:**
- Produces (module exports, for the test and for `main`):
  - `selectCandidates(db): Promise<Candidate[]>` where `Candidate = { proposal_id, client_name, total_price, amount_paid, external_paid, invoice_id, invoice_number, label, amount_due, invoice_amount_paid, link_id, link_amount, payment_id, payment_amount, refund_count }` (money on the invoice/payment side in cents, proposal side in dollars, as the tables hold them).
  - `excludeReason(candidate): string | null` returning `'external_paid'`, `'legal_hold'`, `'has_refund'`, or `null`.
  - `applyCandidate(db, candidate): Promise<{ linesRegenerated: boolean }>`; one transaction per candidate.
  - `main(argv)`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/backfill-full-payment-invoices.test.js
// The one-off repair for the fourteen bookings whose Deposit invoice absorbed
// $100 of a full payment (spec 2026-08-28 §5). Selection is by shape, not by
// a hand-typed list. The refund exclusion is tested on the pure predicate
// because proposal_refunds carries columns this test has no business seeding.
require('dotenv').config();

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../server/db');
const { selectCandidates, excludeReason, applyCandidate } = require('./backfill-full-payment-invoices');

if (process.env.NODE_ENV === 'production') {
  throw new Error('backfill-full-payment-invoices.test.js refuses to run against production');
}

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
let seq = 0;
const clientIds = [];
const proposalIds = [];

// The exact shape prod holds for proposal 774 after 2026-08-28 17:04: a paid,
// locked $100 Deposit; a $550 proposal_payments row; a $100 invoice_payments link.
async function seedStranded({ externalPaid = 0, totalPrice = 550, paymentCents = 55000, status = 'completed' } = {}) {
  seq += 1;
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [`Backfill Test ${seq}`, `bf-${NONCE}-${seq}@example.test`]);
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, external_paid, payment_type,
                            pricing_snapshot, event_date, event_start_time, event_duration_hours, event_type)
     VALUES ($1, $2, $3, $3, 100, $4, 'full',
             '{"package": {"name": "The Core Reaction", "base_cost": 350}, "total": 550}'::jsonb,
             CURRENT_DATE - INTERVAL '10 days', '6:00 PM', 4, 'Cocktail Party') RETURNING id`,
    [c.rows[0].id, status, totalPrice, externalPaid]
  );
  const proposalId = p.rows[0].id;
  proposalIds.push(proposalId);
  const i = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked, locked_at)
     VALUES ($1, $2, 'Deposit', 10000, 10000, 'paid', true, NOW()) RETURNING id`,
    [proposalId, `BF${NONCE}${seq}`]
  );
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
     VALUES ($1, $2, 'full', $3, 'succeeded') RETURNING id`,
    [proposalId, `pi_bf_${NONCE}_${seq}`, paymentCents]
  );
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 10000)`,
    [i.rows[0].id, pay.rows[0].id]
  );
  return { proposalId, invoiceId: i.rows[0].id, paymentId: pay.rows[0].id };
}

after(async () => {
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('selection finds the stranded shape and reports the true payment amount', async () => {
  const s = await seedStranded();
  const rows = await selectCandidates(pool);
  const mine = rows.find((r) => r.proposal_id === s.proposalId);
  assert.ok(mine, 'the seeded row is a candidate');
  assert.equal(mine.invoice_id, s.invoiceId);
  assert.equal(mine.payment_id, s.paymentId);
  assert.equal(Number(mine.payment_amount), 55000);
  assert.equal(Number(mine.amount_due), 10000);
  assert.equal(Number(mine.link_amount), 10000);
  assert.equal(excludeReason(mine), null);
});

test('the CC-transfer cohort is selected by shape but excluded by reason', async () => {
  const s = await seedStranded({ externalPaid: 100 });
  const rows = await selectCandidates(pool);
  const mine = rows.find((r) => r.proposal_id === s.proposalId);
  assert.ok(mine, 'shape matches');
  assert.equal(excludeReason(mine), 'external_paid');
});

test('excludeReason: legal hold and refunds are skips; a clean row is null', () => {
  const base = { proposal_id: 1, external_paid: '0', refund_count: 0 };
  assert.equal(excludeReason({ ...base, proposal_id: 600 }), 'legal_hold');
  assert.equal(excludeReason({ ...base, refund_count: 1 }), 'has_refund');
  assert.equal(excludeReason({ ...base, external_paid: '25.00' }), 'external_paid');
  assert.equal(excludeReason(base), null);
});

test('apply rewrites the invoice and the link to the payment amount, regenerates lines when the total still matches, breadcrumbs once, and is idempotent', async () => {
  const s = await seedStranded();
  const [cand] = (await selectCandidates(pool)).filter((r) => r.proposal_id === s.proposalId);
  const out = await applyCandidate(pool, cand);
  assert.equal(out.linesRegenerated, true);

  const inv = (await pool.query('SELECT label, amount_due, amount_paid, status, locked FROM invoices WHERE id = $1', [s.invoiceId])).rows[0];
  assert.equal(inv.label, 'Full Payment');
  assert.equal(Number(inv.amount_due), 55000);
  assert.equal(Number(inv.amount_paid), 55000);
  assert.equal(inv.status, 'paid');
  assert.equal(inv.locked, true);

  const link = (await pool.query('SELECT amount FROM invoice_payments WHERE invoice_id = $1 AND payment_id = $2', [s.invoiceId, s.paymentId])).rows[0];
  assert.equal(Number(link.amount), 55000);

  const lines = (await pool.query('SELECT description FROM invoice_line_items WHERE invoice_id = $1', [s.invoiceId])).rows;
  assert.ok(lines.length >= 1);

  const bc = (await pool.query(
    "SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'invoice_backfilled_to_full'", [s.proposalId]
  )).rows;
  assert.equal(bc.length, 1);
  assert.equal(bc[0].details.from_amount_due, 10000);
  assert.equal(bc[0].details.to_amount_due, 55000);
  assert.equal(bc[0].details.lines_regenerated, true);

  const again = (await selectCandidates(pool)).filter((r) => r.proposal_id === s.proposalId);
  assert.equal(again.length, 0, 'no longer a candidate: idempotent');
});

test('apply leaves the lines alone when the proposal total has moved since the payment', async () => {
  // Paid $550 once; the proposal was later adjusted to $500 (a cancelled line).
  const s = await seedStranded({ totalPrice: 500, paymentCents: 55000 });
  const [cand] = (await selectCandidates(pool)).filter((r) => r.proposal_id === s.proposalId);
  assert.ok(cand, 'still the stranded shape');
  const out = await applyCandidate(pool, cand);
  assert.equal(out.linesRegenerated, false);
  const lines = (await pool.query('SELECT 1 FROM invoice_line_items WHERE invoice_id = $1', [s.invoiceId])).rowCount;
  assert.equal(lines, 0, 'no lines were written');
  const inv = (await pool.query('SELECT amount_due FROM invoices WHERE id = $1', [s.invoiceId])).rows[0];
  assert.equal(Number(inv.amount_due), 55000, 'the receipt still says what was paid');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from repo root): `node --test scripts/backfill-full-payment-invoices.test.js`
Expected: FAIL, `Cannot find module './backfill-full-payment-invoices'`.

- [ ] **Step 3: Write the script**

```js
#!/usr/bin/env node
'use strict';
/**
 * backfill-full-payment-invoices.js — one-time repair (spec 2026-08-28 §5).
 *
 * Fourteen bookings paid in full on deposit terms carry a paid, locked $100
 * Deposit invoice and no invoice behind the rest of the money, because the
 * webhook's label-blind link credited the capture onto the send-time Deposit
 * row and the cap dropped the overflow. The code fix (upgradeDepositInvoiceToFull)
 * stops it happening again; this script corrects the rows already in that shape.
 *
 * What is frozen in those locked rows is a recording error, not a true receipt.
 * proposal_payments holds the truth, so each row is rewritten to it:
 *   invoices: label Full Payment, amount_due = amount_paid = the linked payment's amount
 *   invoice_payments: amount = the same
 *   line items regenerate ONLY when total_price still equals the payment (otherwise
 *   the proposal moved since, and a receipt for a number nobody paid is worse than
 *   stale lines)
 *   one proposal_activity_log breadcrumb, invoice_backfilled_to_full, per proposal
 *
 * Selection is by SHAPE, not a hand-typed list. Exclusions: external_paid > 0
 * (the CC-transfer cohort, documented separately), proposal 600 (legal hold),
 * any proposal_refunds row (needs eyes, not a script).
 *
 * Dry run by default. Prints the database host and the mode before anything.
 *
 *   node -r dotenv/config scripts/backfill-full-payment-invoices.js            # dry run
 *   node -r dotenv/config scripts/backfill-full-payment-invoices.js --apply    # write
 *
 * Idempotent: an upgraded row is no longer labelled Deposit and is not re-selected.
 * One transaction per proposal: a failure leaves the rest untouched.
 */
const { pool } = require('../server/db');
const { toCents } = require('../server/utils/invoiceShared');
const { generateLineItemsFromProposal, writeLineItems } = require('../server/utils/invoiceLineItems');

const LEGAL_HOLD_PROPOSAL_IDS = new Set([600]);

const SELECT_SQL = `
  WITH contract AS (
    SELECT i.proposal_id, count(*) AS n, min(i.id) AS invoice_id
      FROM invoices i
     WHERE i.status <> 'void' AND i.label IN ('Deposit', 'Balance', 'Full Payment')
     GROUP BY i.proposal_id
  )
  SELECT p.id AS proposal_id, c.name AS client_name,
         p.total_price, p.amount_paid, p.external_paid,
         i.id AS invoice_id, i.invoice_number, i.label, i.amount_due,
         i.amount_paid AS invoice_amount_paid,
         ip.id AS link_id, ip.amount AS link_amount,
         pp.id AS payment_id, pp.amount AS payment_amount,
         (SELECT count(*)::int FROM proposal_refunds r WHERE r.proposal_id = p.id) AS refund_count
    FROM proposals p
    JOIN contract ct ON ct.proposal_id = p.id AND ct.n = 1
    JOIN invoices i ON i.id = ct.invoice_id
                   AND i.label = 'Deposit' AND i.status = 'paid' AND i.locked = true
    JOIN invoice_payments ip ON ip.invoice_id = i.id AND ip.refund_id IS NULL
    JOIN proposal_payments pp ON pp.id = ip.payment_id AND pp.status = 'succeeded'
    LEFT JOIN clients c ON c.id = p.client_id
   WHERE p.amount_paid >= p.total_price AND p.total_price > 0
     AND pp.amount > i.amount_due
   ORDER BY p.id`;

async function selectCandidates(db) {
  const { rows } = await db.query(SELECT_SQL);
  return rows;
}

function excludeReason(c) {
  if (LEGAL_HOLD_PROPOSAL_IDS.has(Number(c.proposal_id))) return 'legal_hold';
  if (Number(c.external_paid || 0) > 0) return 'external_paid';
  if (Number(c.refund_count || 0) > 0) return 'has_refund';
  return null;
}

function describe(c) {
  const linesWillRegenerate = toCents(c.total_price) === Number(c.payment_amount);
  return `#${c.proposal_id} ${c.client_name || '(no client)'}: ${c.invoice_number} ${c.label} `
    + `due ${Number(c.amount_due) / 100} paid ${Number(c.invoice_amount_paid) / 100} `
    + `-> Full Payment due ${Number(c.payment_amount) / 100} paid ${Number(c.payment_amount) / 100}; `
    + `link ${Number(c.link_amount) / 100} -> ${Number(c.payment_amount) / 100}; `
    + `lines ${linesWillRegenerate ? 'regenerate' : 'LEFT ALONE (total_price moved)'}`;
}

async function applyCandidate(db, c) {
  const paymentCents = Number(c.payment_amount);
  const linesRegenerated = toCents(c.total_price) === paymentCents;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE invoices SET label = 'Full Payment', amount_due = $1, amount_paid = $1
        WHERE id = $2 AND label = 'Deposit' RETURNING id`,
      [paymentCents, c.invoice_id]
    );
    if (upd.rowCount !== 1) throw new Error(`invoice ${c.invoice_id} was not a Deposit at apply time`);
    await client.query('UPDATE invoice_payments SET amount = $1 WHERE id = $2', [paymentCents, c.link_id]);
    if (linesRegenerated) {
      const items = await generateLineItemsFromProposal(c.proposal_id, client);
      await writeLineItems(c.invoice_id, items, client);
    }
    await client.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, 'invoice_backfilled_to_full', 'system', $2)`,
      [c.proposal_id, JSON.stringify({
        invoice_id: c.invoice_id,
        invoice_number: c.invoice_number,
        from_amount_due: Number(c.amount_due),
        to_amount_due: paymentCents,
        lines_regenerated: linesRegenerated,
      })]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    throw err;
  } finally {
    client.release();
  }
  return { linesRegenerated };
}

async function main(argv = process.argv) {
  const apply = argv.includes('--apply');
  let host = '(unknown)';
  try { host = new URL(process.env.DATABASE_URL).host; } catch { /* leave unknown */ }
  console.log(`backfill-full-payment-invoices: host=${host} mode=${apply ? 'APPLY' : 'dry run'}`);

  const candidates = await selectCandidates(pool);
  const todo = [];
  for (const c of candidates) {
    const why = excludeReason(c);
    if (why) { console.log(`SKIP  ${describe(c)}  [${why}]`); continue; }
    console.log(`${apply ? 'APPLY' : 'WOULD'} ${describe(c)}`);
    todo.push(c);
  }
  console.log(`${todo.length} to ${apply ? 'apply' : 'apply on --apply'}, ${candidates.length - todo.length} skipped.`);

  if (!apply) return;
  let ok = 0;
  for (const c of todo) {
    try {
      const r = await applyCandidate(pool, c);
      ok += 1;
      console.log(`  done #${c.proposal_id} (lines ${r.linesRegenerated ? 'regenerated' : 'left alone'})`);
    } catch (err) {
      console.error(`  FAILED #${c.proposal_id}: ${err.message}`);
    }
  }
  console.log(`${ok}/${todo.length} applied.`);
}

module.exports = { selectCandidates, excludeReason, applyCandidate, main };

if (require.main === module) {
  main().then(() => pool.end()).catch((err) => {
    console.error(err);
    pool.end().finally(() => process.exit(1));
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from repo root): `node --test scripts/backfill-full-payment-invoices.test.js`
Expected: `pass 5`, `fail 0`.

- [ ] **Step 5: Dry-run against the dev database to see the output shape**

Run (from repo root): `node -r dotenv/config scripts/backfill-full-payment-invoices.js`
Expected: the first line names the dev host and `mode=dry run`; then zero or more `WOULD`/`SKIP` lines for whatever the dev DB holds; nothing writes. This is a shape check only; the dev DB is not prod and its candidate list means nothing.

- [ ] **Step 6: Commit**

```bash
git add scripts/backfill-full-payment-invoices.js scripts/backfill-full-payment-invoices.test.js
git commit -F - <<'MSG'
feat(scripts): backfill the fourteen full payments stranded on a Deposit invoice

Selection by shape, dry run by default, one transaction per proposal, a
breadcrumb each, idempotent. Lines regenerate only when the proposal total
still equals the payment; otherwise the receipt says what was paid and the
stale lines stay, because a receipt for a number nobody paid is worse.
MSG
```

---

### Task 6: Docs, gate, and hand back

**Files:**
- Modify: `docs/fix-list-remaining-2026-07-02.md` (delete the entry `### Paying in full on a deposit-terms proposal strands the remainder off the invoice ledger` and its body, through the sentence ending `documented, different, leave alone.)`; also delete any one-screen-table row that names it: `grep -n "strands" docs/fix-list-remaining-2026-07-02.md`)
- Modify: `docs/walkthroughs-owed.md` (the Tier 1 entry that begins `- [ ] **Sign-and-pay WITH a gratuity, end to end.`)

- [ ] **Step 1: Delete the backlog entry**

The ledger's rule: shipped work is deleted, git holds it. Remove the heading and body named above. Do not leave it struck through.

- [ ] **Step 2: Extend the walkthrough entry**

Inside the Tier 1 entry, after any paragraph beginning `**Added 2026-08-28 (lane pay-settle-page):**` if lane 1 has already merged, otherwise after `**What to watch:**`, add:

```
      **Added 2026-08-28 (lane full-pay-invoice):** after the real full payment, the
      portal Receipts tab must show ONE invoice, "Full Payment", at the with-tip amount,
      paid. Not "Deposit $100 paid". And the backfill: after --apply, Mike Boswell's
      INV-0336 reads Full Payment $550.00 paid, and the Sentry issue
      DRBARTENDER-SERVER-1E (invoice_link_overflow_capped) goes quiet.
```

- [ ] **Step 3: Commit**

```bash
git add docs/fix-list-remaining-2026-07-02.md docs/walkthroughs-owed.md
git commit -F - <<'MSG'
docs: the stranded-remainder entry ships; the receipts tab joins the gratuity walk

Deleted per the ledger's rule. Git holds it.
MSG
```

- [ ] **Step 4: Gate and hand back**

Run (from the lane root): `npm run gate`
Expected: `gate PASSED`.

Then stop. Review is the full pre-prod fleet plus `/second-opinion` (spec §7); this is webhook and ledger. The push cue gates the push, never the review. Report the lane tip sha.

- [ ] **Step 5: After the lane is live on main (not before): the prod backfill**

From the repo root on `main`, with the merged code:

```bash
node -r dotenv/config scripts/backfill-full-payment-invoices.js
```

The first line must name the prod host. Expect fourteen `WOULD` lines; the known set is 774, 770, 767, 713, 675, 674, 666, 660, 659, 635, 633, 625, 623, 573 (633's Deposit is $50, same logic). Any other count: stop and look. Hand the list to Dallas. Only on his word:

```bash
node -r dotenv/config scripts/backfill-full-payment-invoices.js --apply
```

Then confirm on prod: `SELECT label, amount_due, amount_paid FROM invoices WHERE proposal_id = 774` reads `Full Payment, 55000, 55000`.

---

## Self-review against the spec

- §4a helper: Task 1, guard cases pinned (money on it, locked, void, other label, none), formula `total_price − external_paid` pinned, breadcrumb pinned, invoice number unchanged pinned.
- §4b webhook: Task 2, in-tx before the label-blind lookup, `paymentType === 'full'` only; deposit path pinned unchanged; no overflow pinned via captured `console.warn`.
- §4c admin path: Task 3, same helper, `isFullyPaid` only.
- §4d alert: Task 4, category `payment_failure`, email only (no `smsBody`), fire-and-forget with catch, `proposalId` and `remainingCents` added to the anomaly details so the email can name them.
- §5a script, dry run default, host printed: Task 5 `main`.
- §5b selection by shape plus three exclusions: Task 5 `SELECT_SQL` + `excludeReason`; CC cohort and clean row pinned against the DB, legal hold and refund pinned on the predicate.
- §5c per-proposal write, own transaction, lines only when total matches, breadcrumb, idempotent: Task 5 `applyCandidate`, all pinned.
- §5d run order: Task 6 Step 5.
- §6 lane 2 tests: every bullet has a test above. The spec's "the same fixture, deposit intent, still yields Deposit paid plus Balance" is Task 2 test 2.
- §7 review, walkthrough, backlog deletion: Task 6.
- Type consistency: `upgradeDepositInvoiceToFull(proposalId, dbClient)` is the same name and arity in Tasks 1, 2, 3. `excludeReason` returns the same three strings in Task 5's code and test. `applyCandidate` returns `{ linesRegenerated }` in both.
- Nothing calls Stripe. Nothing touches `linkPaymentToInvoice`'s cap or status guard (Task 4 adds a column to its SELECT and a field to one call; the arithmetic is untouched).
