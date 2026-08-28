# Deposit-to-Full Invoice Upgrade Implementation Plan (lane 2: full-pay-invoice)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client who pays in full on a deposit-terms proposal ends up with ONE invoice, `Full Payment`, at the amount they paid, paid and locked, through all three entrances; the 24 bookings already in the wrong shape are corrected; an invoice-link overflow reaches Dallas by email, from after the transaction commits.

**Architecture:** One new lifecycle helper, `upgradeDepositInvoiceToFull(proposalId, dbClient)`, re-derives the open Deposit invoice from the proposal (label, amount, due date, lines) inside the caller's transaction, before the payment is credited. The proposal-page webhook, the payment-link webhook, and the admin record-payment route all call it under the same guard, so the three entrances cannot drift. The existing cap in `linkPaymentToInvoice` is untouched; it simply never overflows on this path any more. `linkPaymentToInvoice` returns enough for its callers to email an overflow after commit. A one-off script with a dry run and a mechanical `--expect` gate repairs the existing rows and records the full before-state.

**Tech Stack:** Node/Express, pg via `server/db`, node:test, the existing invoice lifecycle helpers (`createInvoice`, `generateLineItemsFromProposal`, `writeLineItems`, `linkPaymentToInvoice`), `notifyAdminCategory`.

**Spec:** `docs/superpowers/specs/2026-08-28-post-payment-settle-and-full-pay-invoice-design.md`, sections 1b, 2 (decisions 2, 3, 4, 5), 4, 5, 6 (lane 2), 7.

**Revised 2026-08-28** after the design fleet: the third entrance (`checkoutSessionCompleted.js`) gets its own task; the upgrade call carries the archived/conflict guard; the admin path gates on the derived `isFullyPaid`, stamps `payment_type`, and excludes off-ledger labels; the overflow email moves out of the transaction; the backfill moves to `server/scripts/`, records the full before-state, requires `--expect`, and runs from its own runbook task after the lane is live; the backlog entry is deleted after `--apply`, not before.

## Global Constraints

- `proposals.*` money is DOLLARS (numeric strings from pg). `invoices.*`, `invoice_payments.amount`, `proposal_payments.amount` and Stripe are integer CENTS. `toCents()` from `server/utils/invoiceShared` is the ONE crossing.
- Server tests: from the repo root, one file at a time, `node --test <path>`. Every test file starts with `require('dotenv').config();` and refuses to run when `NODE_ENV === 'production'`. Read the pass count. Server tests share the dev database; clean up every row you create, in dependency order.
- The dev box talks to LIVE Stripe by design. Nothing in this lane calls Stripe. Do not add a Stripe call to a test.
- One pooled connection per request (CLAUDE.md). Nothing that runs `pool.query` may be called while a handler holds a client from `pool.connect()`. The overflow email is post-commit for exactly this reason.
- Commit with explicit pathspecs, never `git add -A`. Commit messages via `git commit -F - <<'MSG'` and never contain backticks.
- Work happens in worktree lane `full-pay-invoice` off `main`. Do not run `npm install` inside the lane.
- Lane 1 (`pay-settle-page`) ships FIRST. This lane adds work to the webhook transaction that lane 1's settle state tolerates. Files both lanes touch: `docs/walkthroughs-owed.md` (same Tier 1 entry), `README.md` (lane 1 around line 623, this lane around 513) and `ARCHITECTURE.md` (lane 1 around 352 to 374, this lane around 1212). Different regions; read any conflict rather than taking a side blindly.
- File-size ratchet: `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js` is 869 lines today and Task 3 adds about 20, so `scripts/check-file-size.js` will WARN (soft cap 700) and there are roughly 110 lines left before growth is blocked at 1000. Keep the Task 3 insertion to what the plan shows; do not add anything to that file that can live in a helper.
- Review: full pre-prod fleet plus `/second-opinion` before merge. Suggested intermediate checkpoints: after Task 4, `code-review` + `consistency-check` on the three call sites; after Task 6, `security-review` on the script.
- The prod backfill (Task 8) runs only after this lane is live on main, from its own runbook, with `--expect`.
- No em dashes in prose written into docs or client-facing strings. The admin email body is prose; keep it dash-free.

---

### Task 1: `upgradeDepositInvoiceToFull`, the helper

**Files:**
- Modify: `server/utils/invoiceLifecycle.js` (add the function before `module.exports`, export it)
- Modify: `server/utils/invoiceHelpers.js` (re-export it in the `require('./invoiceLifecycle')` destructuring and in `module.exports`)
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
// labelled one is never touched and never breadcrumbed.
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

async function seed({ label = 'Deposit', status = 'sent', locked = false, invoiceAmountPaid = 0, totalPrice = 550, externalPaid = 0, balanceDueDate = '2026-09-12' } = {}) {
  seq += 1;
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ('Upgrade Test', $1) RETURNING id`, [`upg-${NONCE}-${seq}@example.test`]);
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, external_paid, balance_due_date,
                            pricing_snapshot, event_date, event_start_time, event_duration_hours, event_type, payment_type)
     VALUES ($1, 'accepted', $2, 0, 100, $3, $4,
             '{"package": {"name": "The Core Reaction", "base_cost": 350}, "total": 550}'::jsonb,
             CURRENT_DATE + INTERVAL '30 days', '6:00 PM', 4, 'Cocktail Party', 'full')
     RETURNING id`,
    [c.rows[0].id, totalPrice, externalPaid, balanceDueDate]
  );
  proposalIds.push(p.rows[0].id);
  const i = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked, due_date)
     VALUES ($1, $2, $3, 10000, $4, $5, $6, NULL) RETURNING id`,
    [p.rows[0].id, `UPG${NONCE}${seq}`, label, invoiceAmountPaid, status, locked]
  );
  invoiceIds.push(i.rows[0].id);
  return { proposalId: p.rows[0].id, invoiceId: i.rows[0].id };
}

const invoice = async (id) => (await pool.query('SELECT * FROM invoices WHERE id = $1', [id])).rows[0];
const breadcrumbs = async (proposalId) => (await pool.query(
  "SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'invoice_upgraded_to_full'", [proposalId]
)).rows;

async function expectUntouched({ proposalId, invoiceId }, label) {
  assert.equal(await upgradeDepositInvoiceToFull(proposalId), null);
  const inv = await invoice(invoiceId);
  assert.equal(inv.label, label);
  assert.equal(Number(inv.amount_due), 10000);
  assert.equal((await breadcrumbs(proposalId)).length, 0, 'no breadcrumb on a guard refusal');
}

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

test('happy path: the open Deposit becomes Full Payment at total_price with the balance due date, lines regenerate, breadcrumb written', async () => {
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
  assert.equal(new Date(inv.due_date).toISOString().slice(0, 10), '2026-09-12', 'same shape createInvoiceOnSend gives a native Full Payment');
  assert.equal(inv.invoice_number, `UPG${NONCE}1`, 'the invoice number never changes');
  const lines = (await pool.query('SELECT description, line_total FROM invoice_line_items WHERE invoice_id = $1 ORDER BY id', [invoiceId])).rows;
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
  await expectUntouched(await seed({ status: 'partially_paid', invoiceAmountPaid: 5000 }), 'Deposit');
});

test('guard: a locked Deposit is never touched', async () => {
  await expectUntouched(await seed({ locked: true }), 'Deposit');
});

test('guard: a void Deposit is never touched', async () => {
  await expectUntouched(await seed({ status: 'void' }), 'Deposit');
});

test('guard: a Balance or Full Payment invoice is not a Deposit', async () => {
  await expectUntouched(await seed({ label: 'Balance' }), 'Balance');
  await expectUntouched(await seed({ label: 'Full Payment' }), 'Full Payment');
});

test('guard: a proposal with no invoice at all returns null and writes nothing', async () => {
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ('Upgrade Test', $1) RETURNING id`, [`upg-none-${NONCE}@example.test`]);
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, event_date, event_start_time, event_duration_hours, event_type)
     VALUES ($1, 'accepted', 550, 0, 100, CURRENT_DATE + INTERVAL '30 days', '6:00 PM', 4, 'Cocktail Party') RETURNING id`,
    [c.rows[0].id]
  );
  proposalIds.push(p.rows[0].id);
  assert.equal(await upgradeDepositInvoiceToFull(p.rows[0].id), null);
  assert.equal((await breadcrumbs(p.rows[0].id)).length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from repo root): `node --test server/utils/invoiceLifecycle.upgrade.test.js`
Expected: FAIL, `upgradeDepositInvoiceToFull is not a function` on every test. Summary `fail 7`.

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
 * credit: label Full Payment, amount_due = total_price − external_paid and
 * due_date = balance_due_date (the exact shape createInvoiceOnSend gives a
 * native Full Payment invoice), lines regenerated. The invoice number does not
 * change. Guarded to an unlocked, unpaid, 'sent' Deposit, row-locked: anything
 * with money on it, locked, void, or differently labelled is never touched and
 * null comes back.
 *
 * Callers, all under the same archived/conflict guard: payment_intent.succeeded,
 * checkout.session.completed, and admin record-payment, only when the payment
 * is a full payment.
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
    'SELECT total_price, external_paid, balance_due_date FROM proposals WHERE id = $1',
    [proposalId]
  );
  if (!prop.rows[0]) return null;
  const amountDueCents = Math.max(0, toCents(prop.rows[0].total_price) - toCents(prop.rows[0].external_paid));

  const upd = await client.query(
    `UPDATE invoices
        SET label = 'Full Payment', amount_due = $1, due_date = $2
      WHERE id = $3
      RETURNING *`,
    [amountDueCents, prop.rows[0].balance_due_date || null, target.id]
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

Add `upgradeDepositInvoiceToFull,` to `module.exports` in `invoiceLifecycle.js` (after `findOpenInvoiceForBalance,`). In `server/utils/invoiceHelpers.js`, add `upgradeDepositInvoiceToFull,` to the `= require('./invoiceLifecycle');` destructuring (after `findOpenInvoiceForBalance,`) AND to `module.exports` (after `createAdditionalInvoiceIfNeeded,`).

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
caller's transaction, row-locked, before the credit. Same amount and due
date a native Full Payment invoice gets. Guarded to an unlocked, unpaid,
sent Deposit; everything else returns null and is never touched.
MSG
```

---

### Task 2: `linkPaymentToInvoice` returns what a post-commit alert needs

**Files:**
- Modify: `server/utils/invoiceLinking.js`
- Test: `server/utils/invoiceLinking.overflowAlert.test.js`

**Interfaces:**
- Produces: `linkPaymentToInvoice(...)` now returns `{ linked, creditedCents, overflowCents, proposalId, invoiceId }` on a link (`proposalId` from the invoice row); the refusal shapes are unchanged. New `notifyLinkOverflow({ proposalId, invoiceId, paymentId, amountCents, creditCents, overflowCents }): Promise<void>` sends one `payment_failure` email via `notifyAdminCategory` (lazy-required), email only, own catch. `warnLinkAnomaly` is unchanged.

- [ ] **Step 1: Write the failing test**

```js
// server/utils/invoiceLinking.overflowAlert.test.js
// spec 2026-08-28 §4e: an overflow reaches Dallas by email, from AFTER the
// transaction commits. The link itself only returns the figures; the caller
// emails from its post-commit tail. notifyAdminCategory runs pool.query, and
// calling it while the caller holds a transaction client is the
// one-pooled-connection deadlock this codebase has hit twice.
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

const { linkPaymentToInvoice, notifyLinkOverflow } = require('./invoiceLinking');

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

test('an overflowing link credits the cap, returns the figures and ids, and sends NO email itself', async () => {
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
  assert.equal(result.proposalId, proposalId);
  assert.equal(result.invoiceId, invoiceId);
  assert.equal(notifyCalls.length, 0, 'the link never emails from inside the transaction');
});

test('notifyLinkOverflow emails the money-anomaly lane once, email only, naming the figures', async () => {
  await notifyLinkOverflow({ proposalId: 774, invoiceId: 336, paymentId: 362, amountCents: 55000, creditCents: 10000, overflowCents: 45000 });
  assert.equal(notifyCalls.length, 1);
  const call = notifyCalls[0];
  assert.equal(call.category, 'payment_failure');
  assert.ok(call.subject.includes('#774'), `subject names the proposal: ${call.subject}`);
  assert.ok(call.emailText.includes('$450.00'), `text names the dropped amount: ${call.emailText}`);
  assert.ok(call.emailText.includes('$100.00'), `text names the credited amount: ${call.emailText}`);
  assert.equal(call.smsBody, undefined, 'email only; SMS costs money');
});

test('notifyLinkOverflow never throws when the notifier fails', async () => {
  require('./adminNotifications').notifyAdminCategory = async () => { throw new Error('resend down'); };
  await assert.doesNotReject(() => notifyLinkOverflow({ proposalId: 1, invoiceId: 2, paymentId: 3, amountCents: 100, creditCents: 50, overflowCents: 50 }));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from repo root): `node --test server/utils/invoiceLinking.overflowAlert.test.js`
Expected: test 1 FAILS on `result.proposalId` (undefined); tests 2 and 3 FAIL with `notifyLinkOverflow is not a function`.

- [ ] **Step 3: Extend the link's return and add the notifier**

In `linkPaymentToInvoice`, change the first query to also select `proposal_id`:

```js
  const invRes = await dbClient.query(
    'SELECT proposal_id, status, amount_due, amount_paid FROM invoices WHERE id = $1 FOR UPDATE',
    [invoiceId]
  );
```

Change the overflow warn to carry the proposal and the remaining figure:

```js
  if (overflowCents > 0) {
    warnLinkAnomaly('overflow_capped', {
      invoiceId, proposalId: inv.proposal_id, paymentId, amountCents, remainingCents, creditCents, overflowCents,
    });
  }
```

Find the function's successful return (the object with `linked: true`) and add `proposalId: inv.proposal_id, invoiceId` to it, so it reads `{ linked: true, creditedCents: creditCents, overflowCents, proposalId: inv.proposal_id, invoiceId }` (keep whatever other fields it already returns).

Add, directly below `warnLinkAnomaly`:

```js
/**
 * Email the money-anomaly lane about an invoice-link overflow (spec
 * 2026-08-28 §4e). Callers invoke this from their POST-COMMIT tail with the
 * figures linkPaymentToInvoice returned in the transaction: notifyAdminCategory
 * runs pool.query, and calling it while holding a transaction client is the
 * one-pooled-connection deadlock (SERVER-17; 2026-07-13). Email only, own
 * catch, never throws. After the deposit-to-full upgrade an overflow on the
 * contract path should be impossible, so this email means something new.
 */
async function notifyLinkOverflow({ proposalId, invoiceId, paymentId, amountCents, creditCents, overflowCents }) {
  try {
    // Lazy: adminNotifications pulls in email + SMS; keep this module's
    // import graph flat (invoiceHelpers is required nearly everywhere).
    const { notifyAdminCategory } = require('./adminNotifications');
    const dollars = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
    const text =
      `A payment of ${dollars(amountCents)} landed on invoice ${invoiceId} (proposal #${proposalId}). `
      + `${dollars(creditCents)} was credited to the invoice and ${dollars(overflowCents)} has no invoice `
      + `behind it. Payment row ${paymentId}. The proposal ledger is correct; the invoice sub-ledger is `
      + `short by that amount.`;
    await notifyAdminCategory({
      category: 'payment_failure',
      subject: `Invoice link overflow on proposal #${proposalId}`,
      emailText: text,
      emailHtml: `<p>${text}</p>`,
    });
  } catch (err) {
    console.error('notifyLinkOverflow failed (non-blocking):', err && err.message);
  }
}
```

Add `notifyLinkOverflow` to the file's `module.exports`, and re-export it from `server/utils/invoiceHelpers.js` (add to the `require('./invoiceLinking')` destructuring and to `module.exports`). Two comments to keep true: update `linkPaymentToInvoice`'s JSDoc `@returns` line (`invoiceLinking.js` around line 42) to `{linked, reason?, creditedCents?, overflowCents?, proposalId?, invoiceId?}`, and add `notifyLinkOverflow` (and, from Task 1, `upgradeDepositInvoiceToFull`) to the header comment in `invoiceHelpers.js` (lines 17 to 22) that enumerates each sibling module's re-exports.

- [ ] **Step 4: Run the test to verify it passes**

Run (from repo root): `node --test server/utils/invoiceLinking.overflowAlert.test.js`
Expected: `pass 3`, `fail 0`. Then `node --test server/routes/proposals/recordPayment.invoiceCap.test.js`: its full count, `fail 0` (its `notifyAdminCategory` stub is a no-op and the route does not call the notifier yet).

- [ ] **Step 5: Commit**

```bash
git add server/utils/invoiceLinking.js server/utils/invoiceHelpers.js server/utils/invoiceLinking.overflowAlert.test.js
git commit -F - <<'MSG'
feat(invoices): the link returns what a post-commit overflow email needs, and the notifier exists

linkPaymentToInvoice now returns proposalId and invoiceId beside the
figures. notifyLinkOverflow emails the money-anomaly lane, email only, never
throws, and is called by its three callers from after COMMIT, because
notifyAdminCategory takes a pooled connection and the link runs inside one.
MSG
```

---

### Task 3: The proposal-page webhook calls the upgrade and emails an overflow after commit

**Files:**
- Modify: `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js` (line 10 require; the label-blind fallback branch; a new `let linkOverflow = null;` beside the other in-tx flags; the post-commit tail)
- Test: `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.fullOnDeposit.test.js`

**Interfaces:**
- Consumes: `upgradeDepositInvoiceToFull`, `notifyLinkOverflow` via `require('../../utils/invoiceHelpers')` (Tasks 1, 2).

- [ ] **Step 1: Write the failing test**

```js
// server/routes/stripeWebhookHandlers/paymentIntentSucceeded.fullOnDeposit.test.js
// A FULL payment on a deposit-terms proposal (spec 2026-08-28 §4b). Before
// this lane the webhook credited 100 dollars of a 550 dollar capture onto the
// send-time Deposit invoice and dropped 450 into a Sentry warning. Afterwards
// there is exactly one contract invoice, Full Payment, at the capture amount,
// paid and locked, and the link overflows nothing. A DEPOSIT payment on the
// same shape is pinned unchanged, and a full intent on an ARCHIVED proposal
// never upgrades.
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

const overflowCalls = [];
require('../../utils/email').sendEmail = async () => ({ skipped: true });
require('../../utils/adminNotifications').notifyAdminCategory = async () => ({ emailed: 0, texted: 0 });
require('../../utils/eventCreation').createEventShifts = async () => null;
require('../../utils/marketingHandlers').onProposalSignedAndPaid = async () => {};
require('../../utils/marketingHandlers').cancelMarketingForProposal = async () => {};
require('../../utils/depositPaidSchedulers').scheduleDepositPaidReminders = async () => {};
require('../../utils/stripePaymentNotifications').sendPaymentNotifications = async () => {};
require('../../utils/lastMinuteAlert').notifyLastMinuteBooking = () => {};
require('../../utils/invoiceHelpers').notifyLinkOverflow = async (args) => { overflowCalls.push(args); };

const handlePaymentIntentSucceeded = require('./paymentIntentSucceeded');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
let seq = 0;
const clientIds = [];
const proposalIds = [];

const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };

async function seed({ paymentType, status = 'accepted' }) {
  seq += 1;
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ('Full On Deposit', $1) RETURNING id`, [`fod-${NONCE}-${seq}@example.test`]);
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, external_paid,
                            pricing_snapshot, event_date, event_start_time, event_duration_hours,
                            event_type, payment_type, client_signed_at, balance_due_date)
     VALUES ($1, $2, 550, 0, 100, 0,
             '{"package": {"name": "The Core Reaction", "base_cost": 350}, "total": 550}'::jsonb,
             CURRENT_DATE + INTERVAL '30 days', '6:00 PM', 4, 'Cocktail Party', $3, NOW(),
             CURRENT_DATE + INTERVAL '16 days')
     RETURNING id`,
    [c.rows[0].id, status, paymentType]
  );
  proposalIds.push(p.rows[0].id);
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Deposit', 10000, 0, 'sent', false)`,
    [p.rows[0].id, `FOD${NONCE}${seq}`]
  );
  return p.rows[0].id;
}

function event({ proposalId, paymentType, amountCents }) {
  return { data: { object: { id: `pi_test_${NONCE}_${seq}`, amount: amountCents, payment_method: null, metadata: { proposal_id: String(proposalId), payment_type: paymentType } } } };
}

const contractInvoices = async (proposalId) => (await pool.query(
  `SELECT id, label, amount_due, amount_paid, status, locked FROM invoices
    WHERE proposal_id = $1 AND status <> 'void' AND label IN ('Deposit', 'Balance', 'Full Payment') ORDER BY id`, [proposalId]
)).rows;
const upgrades = async (proposalId) => (await pool.query(
  "SELECT 1 FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'invoice_upgraded_to_full'", [proposalId]
)).rowCount;

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

test('a FULL payment on deposit terms ends with one Full Payment invoice at the capture, paid, locked, no overflow, no email', async () => {
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
  assert.equal(await upgrades(proposalId), 1, 'one upgrade breadcrumb');
  assert.equal(warnings.filter((w) => w.includes('overflow_capped')).length, 0, `overflow warned: ${warnings.join(' | ')}`);
  assert.equal(overflowCalls.length, 0, 'no overflow email');
});

test('a DEPOSIT payment on the same shape is unchanged: Deposit paid, Balance minted, no upgrade', async () => {
  const proposalId = await seed({ paymentType: 'deposit' });
  await handlePaymentIntentSucceeded(event({ proposalId, paymentType: 'deposit', amountCents: 10000 }));
  const invs = await contractInvoices(proposalId);
  assert.equal(invs.length, 2, JSON.stringify(invs));
  const dep = invs.find((i) => i.label === 'Deposit');
  const bal = invs.find((i) => i.label === 'Balance');
  assert.ok(dep && bal);
  assert.equal(Number(dep.amount_paid), 10000);
  assert.equal(dep.status, 'paid');
  assert.equal(dep.locked, true);
  assert.equal(Number(bal.amount_due), 45000);
  assert.equal(bal.status, 'sent');
  assert.equal(await upgrades(proposalId), 0);
});

test('a FULL intent settling on an ARCHIVED proposal never upgrades its invoice', async () => {
  const proposalId = await seed({ paymentType: 'full', status: 'archived' });
  await handlePaymentIntentSucceeded(event({ proposalId, paymentType: 'full', amountCents: 55000 }));
  const invs = await contractInvoices(proposalId);
  assert.equal(invs.length, 1);
  assert.equal(invs[0].label, 'Deposit', 'a cancelled event keeps its invoice shape; the admin refunds');
  assert.equal(await upgrades(proposalId), 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from repo root): `node --test server/routes/stripeWebhookHandlers/paymentIntentSucceeded.fullOnDeposit.test.js`
Expected: test 1 FAILS on `label`: `'Deposit' !== 'Full Payment'`. Tests 2 and 3 pass (they pin today's behaviour). Summary `pass 2`, `fail 1`.

- [ ] **Step 3: Add the call, the guard, the capture, and the post-commit email**

Line 10 of `paymentIntentSucceeded.js`, add the two names to the destructuring:

```js
const { createInvoiceOnSend, createBalanceInvoice, linkPaymentToInvoice, createDrinkPlanExtrasInvoice, findExtrasInvoice, findOpenInvoiceForBalance, upgradeDepositInvoiceToFull, notifyLinkOverflow } = require('../../utils/invoiceHelpers');
```

Beside the other in-tx flags near the top of the handler (directly after `let extensionSettleContext = null;`), add:

```js
      // Set in-tx from linkPaymentToInvoice's return when the label-blind
      // fallback link overflowed; read in the post-commit tail to email the
      // money-anomaly lane. Post-commit because notifyAdminCategory takes a
      // pooled connection (one-pooled-connection rule).
      let linkOverflow = null;
```

In the label-blind fallback branch, insert ABOVE the eight-line comment that begins `// Off-ledger exclusion (merge-gate finding, 2026-08-03)` (around line 591):

```js
              // Deposit-to-full upgrade (spec 2026-08-28 §4b). A full payment
              // on a deposit-terms proposal arrives with the send-time Deposit
              // invoice open. Re-derive it into the Full Payment invoice NOW,
              // in this transaction, so the link below fits the whole capture
              // instead of crediting $100 and overflowing the rest. The
              // gratuity election was applied to total_price above, so the
              // helper reads the final total. Same guard as createBalanceInvoice
              // below: a stale full intent on a cancelled event or a non-chosen
              // option never relabels and reprices its invoice.
              if (paymentType === 'full' && !groupChoice.conflict && !archivedSettle) {
                await upgradeDepositInvoiceToFull(proposalId, dbClient);
              }
```

Change the link line in that branch from

```js
                await linkPaymentToInvoice(openInvoice.rows[0].id, paymentRowId, intent.amount, dbClient);
```

to

```js
                const linkResult = await linkPaymentToInvoice(openInvoice.rows[0].id, paymentRowId, intent.amount, dbClient);
                if (linkResult && linkResult.linked && linkResult.overflowCents > 0) {
                  linkOverflow = { ...linkResult, paymentId: paymentRowId, amountCents: intent.amount, creditCents: linkResult.creditedCents };
                }
```

In the post-commit tail, inside `if (isFirstDelivery) {`, directly before the line `if (!groupChoice.conflict && !archivedSettle) sendPaymentNotifications(proposalId, intent.amount, paymentType);`, add:

```js
        // Overflow email, post-commit and connection released (spec §4e).
        if (linkOverflow) notifyLinkOverflow(linkOverflow);
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from repo root): `node --test server/routes/stripeWebhookHandlers/paymentIntentSucceeded.fullOnDeposit.test.js`
Expected: `pass 3`, `fail 0`.

- [ ] **Step 5: Run the sibling webhook suite**

Run: `node --test server/routes/stripeWebhookHandlers/paymentIntentSucceeded.extension.test.js`
Expected: its full count, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js server/routes/stripeWebhookHandlers/paymentIntentSucceeded.fullOnDeposit.test.js
git commit -F - <<'MSG'
fix(webhook): a full payment on deposit terms upgrades the Deposit invoice before the credit

Twenty-four bookings since June carry a paid 100 dollar Deposit invoice and
no invoice at all behind the rest of the money, because the label-blind link
credited the capture onto the send-time Deposit row and the cap dropped the
overflow into a Sentry warning. The webhook now re-derives that row into the
Full Payment invoice inside its transaction, after the gratuity apply and
before the link, under the same archived/conflict guard as the Balance
mint. An overflow, should one ever happen again, emails from after commit.
MSG
```

---

### Task 4: The payment-link webhook does the same

**Files:**
- Modify: `server/routes/stripeWebhookHandlers/checkoutSessionCompleted.js` (line 10 require; a `let linkOverflow = null;` beside its in-tx flags; the invoice integration block; the post-commit tail)
- Test: `server/routes/stripeWebhookHandlers/checkoutSessionCompleted.fullOnDeposit.test.js`

**Interfaces:**
- Consumes: `upgradeDepositInvoiceToFull`, `notifyLinkOverflow` (Tasks 1, 2). The handler is reached through the signed `POST /api/stripe/webhook` route, as `checkoutSessionCompleted.lastMinute.test.js` does.

- [ ] **Step 1: Write the failing test**

```js
// server/routes/stripeWebhookHandlers/checkoutSessionCompleted.fullOnDeposit.test.js
// The third entrance (spec 2026-08-28 §4c). An admin-issued Stripe payment
// link inside the 14-day window carries payment_type 'full' and settles
// through checkout.session.completed, whose invoice integration links
// label-blind exactly like payment_intent.succeeded. Same helper, same guard,
// same one-invoice shape afterwards. Harness mirrors
// checkoutSessionCompleted.lastMinute.test.js: a signed event through the
// real webhook route.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
process.env.SENTRY_DSN_SERVER = '';
const WEBHOOK_SECRET = 'whsec_test_fullondeposit';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_WEBHOOK_SECRET_TEST = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('checkoutSessionCompleted.fullOnDeposit.test.js refuses to run against production');
}

require('../../utils/email').sendEmail = async () => ({ skipped: true });
require('../../utils/adminNotifications').notifyAdminCategory = async () => ({ emailed: 0, texted: 0 });
require('../../utils/eventCreation').createEventShifts = async () => null;
require('../../utils/marketingHandlers').onProposalSignedAndPaid = async () => {};
require('../../utils/marketingHandlers').cancelMarketingForProposal = async () => {};
require('../../utils/depositPaidSchedulers').scheduleDepositPaidReminders = async () => {};
require('../../utils/stripePaymentNotifications').sendPaymentNotifications = async () => {};
require('../../utils/lastMinuteAlert').notifyLastMinuteBooking = () => {};
const overflowCalls = [];
require('../../utils/invoiceHelpers').notifyLinkOverflow = async (args) => { overflowCalls.push(args); };

const stripeRouter = require('../stripe');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
const proposalIds = [];
const clientIds = [];

function sign(payloadStr) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payloadStr}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

function postWebhook(eventObj) {
  const payload = JSON.stringify(eventObj);
  const sig = sign(payload);
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/api/stripe/webhook');
    const buf = Buffer.from(payload);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'stripe-signature': sig },
    }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject);
    r.write(buf); r.end();
  });
}

function linkEvent({ id, proposalId, paymentType, amountTotal }) {
  return {
    id: `evt_${id}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${id}`,
        payment_status: 'paid',
        payment_intent: `pi_${id}`,
        payment_link: `plink_${id}`,
        amount_total: amountTotal,
        customer_details: { email: `link-${id}@example.com` },
        metadata: { proposal_id: String(proposalId), payment_type: paymentType },
      },
    },
  };
}

async function seed({ paymentType }) {
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ('Link Full On Deposit', $1) RETURNING id`, [`lfod-${NONCE}-${clientIds.length}@example.com`]);
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, external_paid, pricing_snapshot,
                            event_date, event_start_time, event_duration_hours, event_type, payment_type, balance_due_date)
     VALUES ($1, 'sent', 550, 0, 100, 0, '{"package": {"name": "The Core Reaction", "base_cost": 350}, "total": 550}'::jsonb,
             CURRENT_DATE + INTERVAL '30 days', '6:00 PM', 4, 'Cocktail Party', $2, CURRENT_DATE + INTERVAL '16 days')
     RETURNING id`,
    [c.rows[0].id, paymentType]
  );
  proposalIds.push(p.rows[0].id);
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Deposit', 10000, 0, 'sent', false)`,
    [p.rows[0].id, `LFD${NONCE}${proposalIds.length}`]
  );
  return p.rows[0].id;
}

const contractInvoices = async (proposalId) => (await pool.query(
  `SELECT id, label, amount_due, amount_paid, status, locked FROM invoices
    WHERE proposal_id = $1 AND status <> 'void' AND label IN ('Deposit', 'Balance', 'Full Payment') ORDER BY id`, [proposalId]
)).rows;

before(async () => {
  const app = express();
  // The raw-body mount lives in server/index.js:214, NOT in the stripe router.
  // Without it req.body is undefined, constructEvent throws, and the webhook
  // route 400s before the handler runs. Mirrors the lastMinute harness.
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/stripe', stripeRouter);
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Let un-awaited post-commit work land before teardown (the reference
  // harness does the same). The scheduleDepositPaidReminders stub above is
  // what makes it safe to skip the reference test's handler registration;
  // do not drop that stub.
  await new Promise((r) => setTimeout(r, 400));
  if (server) await new Promise((r) => server.close(r));
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

test('a FULL payment link on deposit terms ends with one Full Payment invoice at the capture, paid, locked', async () => {
  const proposalId = await seed({ paymentType: 'deposit' });
  const r = await postWebhook(linkEvent({ id: `${NONCE}-a`, proposalId, paymentType: 'full', amountTotal: 55000 }));
  assert.equal(r.status, 200, r.body);
  const invs = await contractInvoices(proposalId);
  assert.equal(invs.length, 1, JSON.stringify(invs));
  assert.equal(invs[0].label, 'Full Payment');
  assert.equal(Number(invs[0].amount_due), 55000);
  assert.equal(Number(invs[0].amount_paid), 55000);
  assert.equal(invs[0].status, 'paid');
  assert.equal(invs[0].locked, true);
  const prop = (await pool.query('SELECT status, amount_paid, payment_type FROM proposals WHERE id = $1', [proposalId])).rows[0];
  assert.equal(prop.status, 'balance_paid');
  assert.equal(Number(prop.amount_paid), 550);
  assert.equal(prop.payment_type, 'full');
  assert.equal(overflowCalls.length, 0);
});

test('a DEPOSIT payment link on the same shape is unchanged', async () => {
  const proposalId = await seed({ paymentType: 'deposit' });
  const r = await postWebhook(linkEvent({ id: `${NONCE}-b`, proposalId, paymentType: 'deposit', amountTotal: 10000 }));
  assert.equal(r.status, 200, r.body);
  const invs = await contractInvoices(proposalId);
  assert.equal(invs.length, 2, JSON.stringify(invs));
  assert.ok(invs.find((i) => i.label === 'Deposit' && i.status === 'paid'));
  assert.ok(invs.find((i) => i.label === 'Balance' && Number(i.amount_due) === 45000));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from repo root): `node --test server/routes/stripeWebhookHandlers/checkoutSessionCompleted.fullOnDeposit.test.js`
Expected: test 1 FAILS on `label`: `'Deposit' !== 'Full Payment'`; test 2 passes. If test 1 fails with a non-200 status instead, read the body: the route mounting or the signature helper is wrong, not the handler.

- [ ] **Step 3: Add the call, the capture, and the post-commit email**

Line 10 of `checkoutSessionCompleted.js`:

```js
const { createInvoiceOnSend, createBalanceInvoice, linkPaymentToInvoice, upgradeDepositInvoiceToFull, notifyLinkOverflow } = require('../../utils/invoiceHelpers');
```

Directly after `let archivedSettle = null;` (line 177), add `let linkOverflow = null;` with the same comment as Task 3.

Directly ABOVE the comment `// ── Invoice integration (parity with payment_intent.succeeded) ──`, insert:

```js
          // Deposit-to-full upgrade (spec 2026-08-28 §4c): the payment-link
          // entrance to the same seam. A full link on a deposit-terms proposal
          // re-derives the open Deposit into Full Payment before the link
          // below, under the same guard as createBalanceInvoice.
          if (linkPaymentType === 'full' && !groupChoice.conflict && !archivedSettle) {
            await upgradeDepositInvoiceToFull(proposalId, dbClient);
          }
```

Change its open-invoice lookup (the `SELECT id FROM invoices WHERE proposal_id = $1 AND status IN ('sent', 'partially_paid') ORDER BY created_at ASC LIMIT 1` query) to carry the same off-ledger exclusion the proposal-page webhook has, so all three lookups match (add `const { OFF_LEDGER_INVOICE_LABELS } = require('../../utils/proposalMoneyShared');` beside the other requires if it is not already there):

```js
          const openInvoice = await dbClient.query(
            `SELECT id FROM invoices
              WHERE proposal_id = $1 AND status IN ('sent', 'partially_paid')
                AND NOT (label = ANY($2::text[]))
              ORDER BY created_at ASC LIMIT 1`,
            [proposalId, OFF_LEDGER_INVOICE_LABELS]
          );
```

Change its link line from

```js
              await linkPaymentToInvoice(openInvoice.rows[0].id, paymentRow.rows[0].id, session.amount_total, dbClient);
```

to

```js
              const linkResult = await linkPaymentToInvoice(openInvoice.rows[0].id, paymentRow.rows[0].id, session.amount_total, dbClient);
              if (linkResult && linkResult.linked && linkResult.overflowCents > 0) {
                linkOverflow = { ...linkResult, paymentId: paymentRow.rows[0].id, amountCents: session.amount_total, creditCents: linkResult.creditedCents };
              }
```

In the post-commit tail, directly before the line `if (!groupChoice.conflict && !archivedSettle) sendPaymentNotifications(proposalId, session.amount_total || 0, linkPaymentType);`, add:

```js
        if (linkOverflow) notifyLinkOverflow(linkOverflow);
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from repo root): `node --test server/routes/stripeWebhookHandlers/checkoutSessionCompleted.fullOnDeposit.test.js`
Expected: `pass 2`, `fail 0`.

- [ ] **Step 5: Run the sibling suite**

Run: `node --test server/routes/stripeWebhookHandlers/checkoutSessionCompleted.lastMinute.test.js`
Expected: its full count, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add server/routes/stripeWebhookHandlers/checkoutSessionCompleted.js server/routes/stripeWebhookHandlers/checkoutSessionCompleted.fullOnDeposit.test.js
git commit -F - <<'MSG'
fix(webhook): a full payment link on deposit terms upgrades the Deposit invoice too

The third entrance to the seam. An admin-issued link inside the 14-day
window carries payment_type full and linked label-blind exactly like the
proposal page. Same helper, same guard.
MSG
```

---

### Task 5: The admin record-payment route does the same, on the derived flag

**Files:**
- Modify: `server/routes/proposals/actions.js` (line 23 require; the `record-payment` handler)
- Test: `server/routes/proposals/recordPayment.fullOnDeposit.test.js` (three cases: paid_in_full, typed full amount, and a partial record that overfills its invoice and must email the overflow lane post-commit; the existing `recordPayment.invoiceCap.test.js` is NOT touched, because its fixture caps the applied amount at exactly the invoice's remaining due and so structurally cannot overflow)

**Interfaces:**
- Consumes: `upgradeDepositInvoiceToFull`, `notifyLinkOverflow` (Tasks 1, 2); the route's own `isFullyPaid`.

- [ ] **Step 1: Write the failing tests**

```js
// server/routes/proposals/recordPayment.fullOnDeposit.test.js
// The admin door to the same hole (spec 2026-08-28 §4d, seam sweep L2).
// Gated on the route's DERIVED isFullyPaid, not the request's paid_in_full
// flag: an admin who types the full remaining amount without ticking the box
// is just as fully paid. Also stamps payment_type, so the row agrees with the
// invoice.
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
// actions.js destructures notifyLinkOverflow from invoiceHelpers at require
// time, so the capturing stub must be in place BEFORE the router is required.
const overflowCalls = [];
require('../../utils/invoiceHelpers').notifyLinkOverflow = async (args) => { overflowCalls.push(args); };

const actionsRouter = require('./actions');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
let server, baseUrl, adminId, adminToken, clientId;
const proposalIds = [];

async function seed({ totalPrice = 550, invoiceDue = 10000 } = {}) {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours,
                            total_price, amount_paid, deposit_amount, external_paid, pricing_snapshot, payment_type, balance_due_date)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'accepted', 'Cocktail Party', '6:00 PM', 4,
             $2, 0, 100, 0, '{"package": {"name": "The Core Reaction", "base_cost": 350}, "total": 550}'::jsonb, 'deposit',
             CURRENT_DATE + INTERVAL '16 days')
     RETURNING id`,
    [clientId, totalPrice]
  );
  proposalIds.push(p.rows[0].id);
  const i = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Deposit', $3, 0, 'sent', false) RETURNING id`,
    [p.rows[0].id, `RFD${NONCE}${proposalIds.length}`, invoiceDue]
  );
  return { proposalId: p.rows[0].id, invoiceId: i.rows[0].id };
}

before(async () => {
  const a = await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id`, [`recpay-fod-${NONCE}-admin@example.test`]);
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);
  const c = await pool.query(`INSERT INTO clients (name, email, email_status) VALUES ('Record Full On Deposit', $1, 'ok') RETURNING id`, [`recpay-fod-${NONCE}@example.test`]);
  clientId = c.rows[0].id;

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
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
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

async function expectOneFullInvoice({ proposalId, invoiceId }) {
  const invs = (await pool.query(`SELECT id, label, amount_due, amount_paid, status, locked FROM invoices WHERE proposal_id = $1 AND status <> 'void' ORDER BY id`, [proposalId])).rows;
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
  const prop = (await pool.query('SELECT status, amount_paid, payment_type FROM proposals WHERE id = $1', [proposalId])).rows[0];
  assert.equal(prop.status, 'balance_paid');
  assert.equal(Number(prop.amount_paid), 550);
  assert.equal(prop.payment_type, 'full', 'the row agrees with the invoice');
}

test('paid_in_full on deposit terms ends with one Full Payment invoice at the total, paid, locked, payment_type stamped', async () => {
  const s = await seed();
  const r = await postJson(`/api/proposals/${s.proposalId}/record-payment`, adminToken, { paid_in_full: true, method: 'check' });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.body}`);
  await expectOneFullInvoice(s);
});

test('a typed amount that clears the balance, WITHOUT the paid_in_full box, takes the same path', async () => {
  const s = await seed();
  const r = await postJson(`/api/proposals/${s.proposalId}/record-payment`, adminToken, { amount: 550, method: 'check' });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.body}`);
  await expectOneFullInvoice(s);
});

test('a partial record that overfills the open invoice emails the overflow lane once, after the response', async () => {
  // Not fully paid, so no upgrade; the open invoice is smaller than the
  // applied amount, so the cap credits $100 and $100 overflows. The route's
  // own cap (applied = min(amount, total - paid)) does not bite here because
  // the total is $3000. This is the shape the existing invoiceCap test
  // cannot produce: there the applied amount equals the invoice's due exactly.
  overflowCalls.length = 0;
  const s = await seed({ totalPrice: 3000, invoiceDue: 10000 });
  const r = await postJson(`/api/proposals/${s.proposalId}/record-payment`, adminToken, { amount: 200, method: 'check' });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.body}`);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(overflowCalls.length, 1, 'one overflow email, post-commit');
  assert.equal(overflowCalls[0].proposalId, s.proposalId);
  assert.equal(overflowCalls[0].invoiceId, s.invoiceId);
  assert.equal(overflowCalls[0].creditCents, 10000);
  assert.equal(overflowCalls[0].overflowCents, 10000);
  const inv = (await pool.query('SELECT label, amount_paid, status FROM invoices WHERE id = $1', [s.invoiceId])).rows[0];
  assert.equal(inv.label, 'Deposit', 'no upgrade on a partial record');
  assert.equal(Number(inv.amount_paid), 10000);
  assert.equal(inv.status, 'paid');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from repo root): `node --test server/routes/proposals/recordPayment.fullOnDeposit.test.js`
Expected: `pass 0`, `fail 3`. The first two fail on `label`: `'Deposit' !== 'Full Payment'`; the third fails on `overflowCalls.length`: `0 !== 1` (the route does not call the notifier yet).

- [ ] **Step 3: Add the call, the stamp, the parity exclusion, and the post-commit email**

Line 23 of `actions.js`:

```js
const { linkPaymentToInvoice, createInvoiceOnSend, upgradeDepositInvoiceToFull, notifyLinkOverflow } = require('../../utils/invoiceHelpers');
```

Confirm `OFF_LEDGER_INVOICE_LABELS` is imported in `actions.js` (`grep -n OFF_LEDGER_INVOICE_LABELS server/routes/proposals/actions.js`); if not, add `const { OFF_LEDGER_INVOICE_LABELS } = require('../../utils/proposalMoneyShared');` beside the other requires.

In the `record-payment` handler, find `let` declarations near the top of the handler's transaction block and add `let linkOverflow = null;` alongside them (before `await dbClient.query('BEGIN')`).

Directly ABOVE the comment `// Link payment to the oldest open invoice`, insert:

```js
    // Deposit-to-full upgrade (spec 2026-08-28 §4d): the admin door to the
    // same seam the two webhooks have. Gated on the DERIVED isFullyPaid (from
    // the locked row), not the request's paid_in_full flag: an admin who types
    // the full remaining amount without ticking the box is just as fully paid.
    // Stamp payment_type so the row agrees with the invoice (today only the
    // grouped-winner branch stamps it, and an archived-to-draft-to-sent
    // recovery would read 'deposit' and mint a fresh Deposit).
    if (isFullyPaid) {
      await dbClient.query("UPDATE proposals SET payment_type = 'full' WHERE id = $1", [proposal.id]);
      await upgradeDepositInvoiceToFull(proposal.id, dbClient);
    }
```

Change the open-invoice lookup in that handler from

```js
    const openInvoice = await dbClient.query(
      "SELECT id FROM invoices WHERE proposal_id = $1 AND status IN ('sent', 'partially_paid') ORDER BY created_at ASC LIMIT 1",
      [proposal.id]
    );
```

to (parity with the webhook's off-ledger exclusion):

```js
    const openInvoice = await dbClient.query(
      `SELECT id FROM invoices
        WHERE proposal_id = $1 AND status IN ('sent', 'partially_paid')
          AND NOT (label = ANY($2::text[]))
        ORDER BY created_at ASC LIMIT 1`,
      [proposal.id, OFF_LEDGER_INVOICE_LABELS]
    );
```

Change its link line from

```js
        await linkPaymentToInvoice(openInvoice.rows[0].id, paymentRow.rows[0].id, payAmountCents, dbClient);
```

to

```js
        const linkResult = await linkPaymentToInvoice(openInvoice.rows[0].id, paymentRow.rows[0].id, payAmountCents, dbClient);
        if (linkResult && linkResult.linked && linkResult.overflowCents > 0) {
          linkOverflow = { ...linkResult, paymentId: paymentRow.rows[0].id, amountCents: payAmountCents, creditCents: linkResult.creditedCents };
        }
```

After the transaction's `finally { dbClient.release(); }` block and before the comment `// Email notifications for payment (non-blocking)`, add:

```js
  // Overflow email, post-commit and connection released (spec §4e).
  if (linkOverflow) notifyLinkOverflow(linkOverflow);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/routes/proposals/recordPayment.fullOnDeposit.test.js` → `pass 3`, `fail 0`.
Run: `node --test server/routes/proposals/recordPayment.invoiceCap.test.js` → its full count, `fail 0` (untouched; its `notifyAdminCategory` stub is a no-op and its fixture cannot overflow).
Run: `node --test server/routes/proposals/recordPayment.statusGuard.test.js` and `node --test server/routes/proposals/notifyClient.test.js` → `fail 0` each.

- [ ] **Step 5: Commit**

```bash
git add server/routes/proposals/actions.js server/routes/proposals/recordPayment.fullOnDeposit.test.js
git commit -F - <<'MSG'
fix(record-payment): a fully-paid record upgrades the Deposit invoice, stamps payment_type, and emails an overflow after commit

Gated on the derived isFullyPaid, not the request flag, so a typed amount
that clears the balance takes the same path. The open-invoice lookup gains
the webhook's off-ledger exclusion. Same helper as both webhooks, so the
three entrances cannot drift.
MSG
```

---

### Task 6: The backfill script

**Files:**
- Create: `server/scripts/backfillFullPaymentInvoices.js`
- Test: `server/scripts/backfillFullPaymentInvoices.test.js`

**Interfaces:**
- Produces (module exports): `selectCandidates(db)`, `excludeReason(candidate)` returning `'legal_hold' | 'external_paid' | 'has_refund' | null`, `applyCandidate(db, candidate)` returning `{ linesRegenerated }`, `parseArgs(argv)` returning `{ apply, expect: Set<number> | null }`, `main(argv)`.

- [ ] **Step 1: Write the failing test**

```js
// server/scripts/backfillFullPaymentInvoices.test.js
// The one-off repair for the bookings whose Deposit invoice absorbed $100 of
// a full payment (spec 2026-08-28 §5). Selection is by shape. The write
// records the FULL before-state so it can be reversed by hand, and refuses
// to run without an --expect set that matches the selection exactly.
require('dotenv').config();

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { selectCandidates, excludeReason, applyCandidate, parseArgs } = require('./backfillFullPaymentInvoices');

if (process.env.NODE_ENV === 'production') {
  throw new Error('backfillFullPaymentInvoices.test.js refuses to run against production');
}

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
let seq = 0;
const clientIds = [];
const proposalIds = [];

async function seedStranded({ externalPaid = 0, totalPrice = 550, paymentCents = 55000, status = 'completed', withLines = true } = {}) {
  seq += 1;
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`, [`Backfill Test ${seq}`, `bf-${NONCE}-${seq}@example.test`]);
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
  if (withLines) {
    await pool.query(
      `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, line_total, source_type, source_id)
       VALUES ($1, 'Deposit', 1, 10000, 10000, 'manual', NULL)`,
      [i.rows[0].id]
    );
  }
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
     VALUES ($1, $2, 'full', $3, 'succeeded') RETURNING id`,
    [proposalId, `pi_bf_${NONCE}_${seq}`, paymentCents]
  );
  await pool.query(`INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 10000)`, [i.rows[0].id, pay.rows[0].id]);
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
  const mine = (await selectCandidates(pool)).find((r) => r.proposal_id === s.proposalId);
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
  const mine = (await selectCandidates(pool)).find((r) => r.proposal_id === s.proposalId);
  assert.ok(mine);
  assert.equal(excludeReason(mine), 'external_paid');
});

test('excludeReason: legal hold and refunds are skips; a clean row is null', () => {
  const base = { proposal_id: 1, external_paid: '0', refund_count: 0 };
  assert.equal(excludeReason({ ...base, proposal_id: 600 }), 'legal_hold');
  assert.equal(excludeReason({ ...base, refund_count: 1 }), 'has_refund');
  assert.equal(excludeReason({ ...base, external_paid: '25.00' }), 'external_paid');
  assert.equal(excludeReason(base), null);
});

test('parseArgs: --apply requires --expect, and --expect parses to a set of ids', () => {
  assert.deepEqual(parseArgs(['node', 'x']), { apply: false, expect: null });
  assert.deepEqual(parseArgs(['node', 'x', '--expect', '774,770']), { apply: false, expect: new Set([774, 770]) });
  assert.deepEqual(parseArgs(['node', 'x', '--apply', '--expect', '774']), { apply: true, expect: new Set([774]) });
  assert.throws(() => parseArgs(['node', 'x', '--apply']), /--expect/);
});

test('apply rewrites the invoice and the link, regenerates lines when the total matches, records the full before-state, and is idempotent', async () => {
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
  const lines = (await pool.query('SELECT description FROM invoice_line_items WHERE invoice_id = $1 ORDER BY id', [s.invoiceId])).rows;
  assert.equal(lines[0].description, 'The Core Reaction', 'regenerated from the snapshot');

  const bc = (await pool.query("SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'invoice_backfilled_to_full'", [s.proposalId])).rows;
  assert.equal(bc.length, 1);
  const d = bc[0].details;
  assert.equal(d.from_label, 'Deposit');
  assert.equal(d.from_amount_due, 10000);
  assert.equal(d.from_amount_paid, 10000);
  assert.equal(d.from_link_amount, 10000);
  assert.equal(d.to_amount_due, 55000);
  assert.equal(d.lines_regenerated, true);
  assert.equal(d.from_line_items.length, 1, 'the prior lines are preserved in the breadcrumb');
  assert.equal(d.from_line_items[0].description, 'Deposit');

  const again = (await selectCandidates(pool)).filter((r) => r.proposal_id === s.proposalId);
  assert.equal(again.length, 0, 'no longer a candidate: idempotent');
});

test('apply leaves the lines alone when the proposal total has moved since the payment', async () => {
  const s = await seedStranded({ totalPrice: 500, paymentCents: 55000 });
  const [cand] = (await selectCandidates(pool)).filter((r) => r.proposal_id === s.proposalId);
  assert.ok(cand, 'still the stranded shape');
  const out = await applyCandidate(pool, cand);
  assert.equal(out.linesRegenerated, false);
  const lines = (await pool.query('SELECT description FROM invoice_line_items WHERE invoice_id = $1', [s.invoiceId])).rows;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].description, 'Deposit', 'untouched');
  assert.equal(Number((await pool.query('SELECT amount_due FROM invoices WHERE id = $1', [s.invoiceId])).rows[0].amount_due), 55000, 'the receipt still says what was paid');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from repo root): `node --test server/scripts/backfillFullPaymentInvoices.test.js`
Expected: FAIL, `Cannot find module './backfillFullPaymentInvoices'`.

- [ ] **Step 3: Write the script**

```js
#!/usr/bin/env node
'use strict';
/**
 * backfillFullPaymentInvoices.js — one-time repair (spec 2026-08-28 §5).
 *
 * Bookings paid in full on deposit terms carry a paid, locked $100 Deposit
 * invoice and no invoice behind the rest of the money, because the webhook's
 * label-blind link credited the capture onto the send-time Deposit row and the
 * cap dropped the overflow. The code fix (upgradeDepositInvoiceToFull, at all
 * three entrances) stops it happening again; this script corrects the rows
 * already in that shape. Verified on prod 2026-08-28: 25 by shape, 24 to apply,
 * 633 skipped for its refund.
 *
 * What is frozen in those locked rows is a recording error, not a true receipt.
 * proposal_payments holds the truth, so each row is rewritten to it:
 *   invoices: label Full Payment, amount_due = amount_paid = the linked payment's amount
 *   invoice_payments: amount = the same (keeps sum(invoice_payments) == invoices.amount_paid)
 *   line items regenerate ONLY when total_price still equals the payment; otherwise the
 *   proposal moved since, and a receipt for a number nobody paid is worse than stale lines
 *   one proposal_activity_log breadcrumb per proposal carrying the FULL before-state
 *
 * Selection is by SHAPE, not a hand-typed list. Exclusions: external_paid > 0
 * (the CC-transfer cohort), proposal 600 (legal hold), any proposal_refunds row.
 *
 * Dry run by default. --apply REQUIRES --expect <ids>: the script refuses to
 * write unless the selected set (after exclusions) equals the expected set
 * exactly. Prints the database host and the mode before anything.
 *
 *   DATABASE_URL=<prod> node server/scripts/backfillFullPaymentInvoices.js                                # dry run
 *   DATABASE_URL=<prod> node server/scripts/backfillFullPaymentInvoices.js --apply --expect 442,450,...   # write
 *
 * Idempotent: an upgraded row is no longer labelled Deposit and is not re-selected.
 * One transaction per proposal: a failure leaves the rest untouched.
 */
const { pool } = require('../db');
const { toCents } = require('../utils/invoiceShared');
const { generateLineItemsFromProposal, writeLineItems } = require('../utils/invoiceLineItems');

const LEGAL_HOLD_PROPOSAL_IDS = new Set([600]);

const SELECT_SQL = `
  WITH contract AS (
    SELECT i.proposal_id, count(*) AS n, min(i.id) AS invoice_id
      FROM invoices i
     WHERE i.status <> 'void' AND i.label IN ('Deposit', 'Balance', 'Full Payment')
     GROUP BY i.proposal_id
  ), links AS (
    SELECT ip.invoice_id, count(*) AS n, min(ip.id) AS link_id
      FROM invoice_payments ip
     WHERE ip.refund_id IS NULL
     GROUP BY ip.invoice_id
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
    JOIN links l ON l.invoice_id = i.id AND l.n = 1
    JOIN invoice_payments ip ON ip.id = l.link_id
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

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const i = argv.indexOf('--expect');
  const expect = i >= 0 && argv[i + 1]
    ? new Set(argv[i + 1].split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n)))
    : null;
  if (apply && !expect) throw new Error('--apply requires --expect <comma-separated proposal ids>');
  return { apply, expect };
}

function describe(c) {
  const regen = toCents(c.total_price) === Number(c.payment_amount);
  return `#${c.proposal_id} ${c.client_name || '(no client)'}: ${c.invoice_number} ${c.label} `
    + `due ${Number(c.amount_due) / 100} paid ${Number(c.invoice_amount_paid) / 100} `
    + `-> Full Payment due ${Number(c.payment_amount) / 100} paid ${Number(c.payment_amount) / 100}; `
    + `link ${Number(c.link_amount) / 100} -> ${Number(c.payment_amount) / 100}; `
    + `lines ${regen ? 'regenerate' : 'LEFT ALONE (total_price moved)'}`;
}

async function applyCandidate(db, c) {
  const paymentCents = Number(c.payment_amount);
  const linesRegenerated = toCents(c.total_price) === paymentCents;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query(
      'SELECT label, amount_due, amount_paid FROM invoices WHERE id = $1 FOR UPDATE', [c.invoice_id]
    );
    if (!before.rows[0] || before.rows[0].label !== 'Deposit') {
      throw new Error(`invoice ${c.invoice_id} was not a Deposit at apply time`);
    }
    const priorLines = (await client.query(
      'SELECT description, quantity, unit_price, line_total, source_type, source_id FROM invoice_line_items WHERE invoice_id = $1 ORDER BY id',
      [c.invoice_id]
    )).rows;
    await client.query(
      `UPDATE invoices SET label = 'Full Payment', amount_due = $1, amount_paid = $1 WHERE id = $2`,
      [paymentCents, c.invoice_id]
    );
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
        from_label: before.rows[0].label,
        from_amount_due: Number(before.rows[0].amount_due),
        from_amount_paid: Number(before.rows[0].amount_paid),
        from_link_amount: Number(c.link_amount),
        from_line_items: priorLines,
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
  const { apply, expect } = parseArgs(argv);
  let host = '(unknown)';
  try { host = new URL(process.env.DATABASE_URL).host; } catch { /* leave unknown */ }
  console.log(`backfillFullPaymentInvoices: host=${host} mode=${apply ? 'APPLY' : 'dry run'}`);

  const candidates = await selectCandidates(pool);
  const todo = [];
  for (const c of candidates) {
    const why = excludeReason(c);
    if (why) { console.log(`SKIP  ${describe(c)}  [${why}]`); continue; }
    console.log(`${apply ? 'APPLY' : 'WOULD'} ${describe(c)}`);
    todo.push(c);
  }
  console.log(`${todo.length} selected, ${candidates.length - todo.length} skipped.`);

  if (expect) {
    const got = new Set(todo.map((c) => Number(c.proposal_id)));
    const missing = [...expect].filter((id) => !got.has(id));
    const extra = [...got].filter((id) => !expect.has(id));
    if (missing.length || extra.length) {
      console.error(`REFUSING: selection does not match --expect. missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
      process.exitCode = 2;
      return;
    }
    console.log('--expect matches the selection exactly.');
  }
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

module.exports = { selectCandidates, excludeReason, applyCandidate, parseArgs, main };

if (require.main === module) {
  main().then(() => pool.end()).catch((err) => {
    console.error(err);
    pool.end().finally(() => process.exit(1));
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from repo root): `node --test server/scripts/backfillFullPaymentInvoices.test.js`
Expected: `pass 6`, `fail 0`.

- [ ] **Step 5: Dry-run against the dev database for the output shape only**

Run (from repo root): `node -r dotenv/config server/scripts/backfillFullPaymentInvoices.js`
Expected: the first line names the DEV host and `mode=dry run`; whatever candidates the dev DB holds print as `WOULD`/`SKIP`; nothing writes. This checks the output shape. The dev DB is shared with the test suites and its candidate list means nothing for prod.

- [ ] **Step 6: Commit**

```bash
git add server/scripts/backfillFullPaymentInvoices.js server/scripts/backfillFullPaymentInvoices.test.js
git commit -F - <<'MSG'
feat(scripts): backfill the full payments stranded on a Deposit invoice

Selection by shape, dry run by default, --apply refuses without an --expect
set that matches the selection exactly, one transaction per proposal, a
breadcrumb each carrying the full before-state including the prior line
items, idempotent. Lines regenerate only when the proposal total still
equals the payment.
MSG
```

---

### Task 7: Docs, gate, and hand back

**Files:**
- Modify: `README.md` (the `server/scripts/` enumeration in the folder tree)
- Modify: `ARCHITECTURE.md` (the invoice lifecycle section; wherever `linkPaymentToInvoice` or the deposit/full invoice minting is described)
- Modify: `docs/walkthroughs-owed.md` (the Tier 1 entry beginning `- [ ] **Sign-and-pay WITH a gratuity, end to end.`)

The backlog entry is NOT deleted here. It is deleted in Task 8 after `--apply` succeeds.

- [ ] **Step 1: README**

In the folder tree's `server/scripts/` enumeration, add `backfillFullPaymentInvoices.js (one-off: full payments stranded on a Deposit invoice; dry run, --expect gate)` alongside the other backfill scripts.

- [ ] **Step 2: ARCHITECTURE**

Where the invoice lifecycle describes the send-time Deposit/Full Payment mint and the payment link, add a short paragraph: a full payment on a deposit-terms proposal re-derives the open Deposit invoice into Full Payment (`upgradeDepositInvoiceToFull`) before the credit, at all three entrances (`payment_intent.succeeded`, `checkout.session.completed`, admin record-payment), under the same archived/conflict guard as the Balance mint; an invoice-link overflow emails the `payment_failure` lane from the post-commit tail.

- [ ] **Step 3: Walkthrough**

Inside the Tier 1 entry, after the paragraph beginning `**Added 2026-08-28 (lane pay-settle-page):**` if lane 1 has merged, otherwise after `**What to watch:**`, add:

```
      **Added 2026-08-28 (lane full-pay-invoice):** after the real full payment, the
      portal Receipts tab must show ONE invoice, "Full Payment", at the with-tip amount,
      paid. Not "Deposit $100 paid". Then the backfill (its own runbook in the plan): after
      --apply, Mike Boswell's INV-0336 reads Full Payment $550.00 paid, Karen Habenicht's
      INV-0329 reads Full Payment $300.00 paid, and the Sentry issue DRBARTENDER-SERVER-1E
      (invoice_link_overflow_capped) goes quiet.
```

- [ ] **Step 4: Commit**

```bash
git add README.md ARCHITECTURE.md docs/walkthroughs-owed.md
git commit -F - <<'MSG'
docs: the deposit-to-full upgrade at three entrances, the backfill script, and the receipts walk
MSG
```

- [ ] **Step 5: Gate and hand back**

Run (from the lane root): `npm run gate`
Expected: `gate PASSED (money)` or `(client + money)` if docs count as client; read the line. The money smoke needs `NEON_API_KEY`.

Then stop. Review is the full pre-prod fleet plus `/second-opinion` (spec §7); this is webhook and ledger. The push cue gates the push, never the review. Report the lane tip sha. A gate receipt banked in the lane does not cover the post-squash push of main; the gate re-runs there.

---

### Task 8: The prod backfill runbook (after this lane is live on main)

**Files:**
- Modify: `docs/fix-list-remaining-2026-07-02.md` (delete the entry `### Paying in full on a deposit-terms proposal strands the remainder off the invoice ledger` and its body through the sentence ending `documented, different, leave alone.)`, plus any one-screen-table row that names it: `grep -n "strands" docs/fix-list-remaining-2026-07-02.md`)

This task runs only after lane 2 has merged to main and deployed. It is a checklist for Dallas plus whoever is driving, not a build task.

- [ ] **Step 1: Point at prod, dry run, and check the selection mechanically**

From the repo root on `main`, with the merged code and the prod connection string in the environment for THIS command only (the box's `.env` is the dev database):

```bash
DATABASE_URL='<the prod Neon connection string>' node server/scripts/backfillFullPaymentInvoices.js --expect 442,450,451,452,472,479,484,494,502,556,573,579,623,625,635,659,660,666,674,675,713,767,770,774
```

Expected: the first line names the PROD host. Twenty-four `WOULD` lines, one `SKIP ... [has_refund]` line for 633, and `--expect matches the selection exactly.` Any refusal line means the set changed since 2026-08-28: stop and look at the diff it prints before doing anything else.

- [ ] **Step 2: Dallas reads the 24 lines**

Hand the dry-run output to Dallas. Only on his word:

- [ ] **Step 3: Apply**

```bash
DATABASE_URL='<the prod Neon connection string>' node server/scripts/backfillFullPaymentInvoices.js --apply --expect 442,450,451,452,472,479,484,494,502,556,573,579,623,625,635,659,660,666,674,675,713,767,770,774
```

Expected: `24/24 applied.` Any `FAILED #N` line: that proposal rolled back on its own; the rest landed; investigate N before re-running (a re-run is safe; it selects only what is still a Deposit).

- [ ] **Step 4: Verify**

On prod, read-only:

```sql
SELECT proposal_id, invoice_number, label, amount_due, amount_paid, locked
  FROM invoices WHERE proposal_id IN (774, 767, 770) ORDER BY proposal_id;
```

Expected: three `Full Payment` rows, `amount_due = amount_paid`, `locked = true`; 774 at 55000, 767 at 30000, 770 at 42500. A second dry run selects only 633.

- [ ] **Step 5: Close the paper trail**

Delete the backlog entry named above (the ledger's rule: shipped work is deleted, git holds it). Resolve Sentry issue DRBARTENDER-SERVER-1E. Tick the receipts line in the walkthrough entry. Look at 633 by hand: Dora Travaglio, $430 paid on a $50 Deposit invoice with one refund on file; decide whether the same rewrite is right for her or whether the refund changes the shape.

```bash
git add docs/fix-list-remaining-2026-07-02.md docs/walkthroughs-owed.md
git commit -F - <<'MSG'
docs(backlog): the stranded-remainder entry ships; 24 receipts corrected on prod

Deleted per the ledger's rule. Git holds it. 633 held for a manual look.
MSG
```

---

## Self-review against the spec

- §4a helper: Task 1, guard cases pinned with no-breadcrumb assertions, formula and `due_date = balance_due_date` pinned, `FOR UPDATE`, invoice number unchanged.
- §4b webhook: Task 3, guard `!groupChoice.conflict && !archivedSettle`, archived case pinned, overflow captured in-tx and emailed post-commit.
- §4c payment link: Task 4, through the signed route, same guard and shape.
- §4d admin: Task 5, derived `isFullyPaid`, `payment_type` stamp, off-ledger parity, typed-amount case pinned, post-commit email pinned in the cap test.
- §4e alert: Task 2 (notifier, never inside the transaction, pinned) and Tasks 3, 4, 5 (the three post-commit call sites).
- §5a script location, dry run, `--expect`, host print, explicit prod connection: Tasks 6 and 8.
- §5b selection with exactly one link row and three exclusions: Task 6.
- §5c full before-state, invariant, lines only when total matches, idempotent: Task 6, pinned.
- §5d run order, backlog deletion after apply, Sentry resolve, 633 by hand: Task 8.
- §6 lane 2: every bullet has a test above.
- §7 docs, fleet, gate: Task 7.
- Type consistency: `upgradeDepositInvoiceToFull(proposalId, dbClient)` and `notifyLinkOverflow({...})` carry the same names and shapes in Tasks 1 through 5; `linkPaymentToInvoice`'s extended return (`proposalId`, `invoiceId`, `creditedCents`, `overflowCents`) is what all three callers spread into `linkOverflow`; `excludeReason` returns the same three strings in code and test; `parseArgs` and `applyCandidate` shapes match their tests.
- Nothing calls Stripe. Nothing touches `linkPaymentToInvoice`'s cap or status guard.
