---
spec: docs/superpowers/specs/2026-09-14-bank-debit-in-flight-design.md
lanes:
  - id: ach-server
    footprint:
      - server/db/schema.sql                                   # status CHECK widens; processing_at + invoice_id (spec 3.1)
      - server/db/index.js                                     # CONSTRAINT_CONTRACT entry (spec 3.1)
      - server/utils/errors.js                                 # DeferMessageError (spec 6)
      - server/utils/scheduledMessageDispatcher.js             # defer branch (spec 6); file is past the 700 soft cap, warning expected
      - server/utils/scheduledMessageDispatcher.test.js        # exists: extend
      - server/utils/paymentInFlight.js                        # new: the one in-flight definition + rail backstop (spec 3.2)
      - server/utils/paymentInFlight.test.js
      - server/utils/lifecycleEmailTemplates.js                # bankPaymentProcessingClient (spec 9); past the 700 soft cap, warning expected
      - server/utils/emailTemplates.js                         # re-export only; past the 700 soft cap, warning expected
      - server/utils/bankPaymentProcessingNotify.js            # new: post-commit client email (spec 9)
      - server/utils/bankPaymentProcessingNotify.test.js
      - server/routes/stripeWebhookHandlers/paymentIntentProcessing.js   # new (spec 4.1)
      - server/routes/stripeWebhook.js                         # dispatch line (spec 4.1)
      - server/routes/stripeWebhook.processing.test.js
      - server/routes/stripe.js                                # invoice rail guard + insert carries invoice_id (spec 5.1)
      - server/routes/stripe.invoiceIntentInFlight.test.js
      - server/routes/stripe.drinkPlanIntentInFlight.test.js   # review round: third rail (spec 5.1)
      - server/routes/stripeCreateIntent.js                    # deposit rail guard (spec 5.1)
      - server/routes/stripeCreateIntent.test.js               # exists: extend
      - server/utils/autopayDurableCharge.js                   # scan widens (spec 5.2)
      - server/utils/autopayDurableCharge.test.js              # exists: extend
      - server/routes/proposals/publicSwitch.js                # two scans widen (spec 5.2)
      - server/routes/proposals/publicSwitch.test.js           # exists: extend
      - server/utils/balanceReminderHandlers.js                # defer when in flight (spec 6)
      - server/utils/balanceReminderHandlers.test.js           # new
      - server/utils/balanceSmsHandlers.js                     # defer when in flight (spec 6)
      - server/utils/balanceSmsHandlers.test.js                # exists: extend
      - server/routes/invoices.js                              # public + admin payloads (spec 7)
      - server/routes/invoices.pendingPayment.test.js          # new
      - server/routes/proposals/publicToken.js                 # proposal GET + payment-state payloads (spec 7)
      - server/routes/proposals/publicToken.paymentState.test.js   # exists: extend
      - README.md
      - ARCHITECTURE.md
      - docs/fix-list-remaining-2026-07-02.md
      - docs/walkthroughs-owed.md
    depends_on: []
    review: full            # stripe.js, stripeWebhook.js, publicToken.js, scheduledMessageDispatcher.js are on scripts/sensitive-paths.txt
  - id: ach-client
    footprint:
      - client/src/components/PendingPaymentCard.js            # new (spec 8.1)
      - client/src/components/PendingPaymentCard.test.js
      - client/src/pages/invoice/InvoicePage.js                # processing branch + pending state (spec 8.2)
      - client/src/pages/invoice/InvoicePage.test.js           # new
      - client/src/pages/proposal/proposalView/PaidCard.js     # pending phase + pendingPayment prop (spec 8.3)
      - client/src/pages/proposal/proposalView/PaidCard.test.js        # exists: extend
      - client/src/pages/proposal/proposalView/settlePoll.js   # pending terminal (spec 8.3)
      - client/src/pages/proposal/proposalView/settlePoll.test.js      # exists: extend
      - client/src/pages/proposal/proposalView/useSettle.js    # pending phase (spec 8.3)
      - client/src/pages/proposal/proposalView/useSettle.test.js       # exists: extend
      - client/src/pages/proposal/proposalView/checkoutVisibility.js   # new: pure gating extracted from ProposalView (spec 8.3)
      - client/src/pages/proposal/proposalView/checkoutVisibility.test.js
      - client/src/pages/proposal/proposalView/ProposalView.js # wiring only; 912 lines, must not grow past 1000, net change is negative
      - client/src/pages/admin/PendingPaymentsList.js          # new (spec 10)
      - client/src/pages/admin/PendingPaymentsList.test.js
      - client/src/pages/admin/ProposalDetailPaymentPanel.js   # reads pending_payments, renders the list (spec 10)
      - client/src/pages/proposal/proposalView/PaymentTermsBox.js          # review round: pending copy (spec 8.3)
      - client/src/pages/proposal/proposalView/PaymentTermsBox.test.js
      - client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js # review round: Total prints Pending (spec 8.3)
      - client/src/pages/proposal/proposalView/ProposalPricingBreakdown.test.js
      - client/src/pages/plan/components/PaymentReturnNotice.js  # review round: drink-plan return notice (spec 8.4)
      - client/src/pages/plan/components/PaymentReturnNotice.test.js
      - client/src/pages/plan/v2/PlannerV2.js                  # review round: reads redirect_status (spec 8.4)
      - client/src/pages/plan/v2/steps/CelebrationV2.js        # review round (spec 8.4)
      - client/src/pages/plan/v2/steps/CelebrationV2.test.js
      - client/src/pages/plan/PotionPlanningLab.js             # review round (spec 8.4); shrinks by 9 lines
      - README.md
    depends_on: []
    review: full            # client half of a payment path; the invoice page and proposal page are money surfaces
---

# Bank Debit In Flight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bank debit that Stripe holds in `processing` for four to six business days is visible to the system the whole time: no second intent can be minted on that proposal, the invoice and proposal pages say the payment is processing instead of asking for it again, the balance reminders wait, the client gets one email saying it was received, and the admin sees it on the proposal.

**Architecture:** One new row state, `stripe_sessions.status = 'processing'`, written only by a new `payment_intent.processing` webhook handler and released by the existing succeeded and payment-failed handlers. One helper module, `server/utils/paymentInFlight.js`, is the only reader of that state; both checkout rails, the reminder handlers, the public invoice and proposal payloads and the admin invoices payload call it. The client renders one shared `PendingPaymentCard` from the payload's `pending_payment` on both public pages; the proposal page's gating logic is extracted into a pure `checkoutVisibility` module so the pending state is one more input, tested on its own.

**Tech Stack:** Express + pg (raw SQL, `pool.query`), node:test against the shared dev DB, the existing signed-webhook test harness (`stripeWebhook.guards.test.js`), React 18 (CRA, jest + @testing-library/react 13.4), Stripe.js Payment Element.

**Spec:** `docs/superpowers/specs/2026-09-14-bank-debit-in-flight-design.md`. Section numbers below refer to it.

## Global Constraints

- `proposals.*` money is DOLLARS (numeric strings from pg). `invoices.*`, `stripe_sessions.amount`, `proposal_payments.amount` and every Stripe amount are integer CENTS. The payload field is named `amount_cents` so nobody has to guess.
- No em dashes in any client-facing copy, email, SMS, 409 message or admin line. Use a period, a comma, or a colon. Copy strings are given verbatim in the tasks; use them as written.
- Server tests: from the lane root, one file at a time, `node --test <path>`. Every server test file starts with `require('dotenv').config();` and refuses to run when `NODE_ENV === 'production'`. Read the pass count; a suite that reports 0 tests did not run. Tests share the dev database: clean up every row you create, in dependency order.
- Client tests: from `client/`, `CI=true npx react-scripts test --testPathPattern=<pattern> --watchAll=false`. jest-dom matchers are NOT available; assert on `.textContent`, `.getAttribute`, and `screen.queryBy*` being null.
- The dev box talks to LIVE Stripe by design. Nothing in either lane calls Stripe outside a fake. Never create, confirm, retrieve or cancel a real intent from a test or a one-off script.
- One pooled connection per request (CLAUDE.md). The processing handler releases its client before the post-commit email.
- Stripe API calls go through `server/utils/stripeClient.js` (`getStripe()`), never `require('stripe')`.
- Commit with explicit pathspecs (`git add <files>`), never `git add -A`. Commit messages via `git commit -F - <<'MSG'` and never contain backticks.
- Each lane is a worktree cut with `npm run worktree:new -- <lane-id>` from `os` on `main`. Do not run `npm install` inside a lane. The helper links `.env` into the lane.
- File-size ratchet: `scheduledMessageDispatcher.js` (775), `lifecycleEmailTemplates.js` (801) and `emailTemplates.js` (904) are past the 700 soft cap and will WARN; each grows by under 40 lines. `ProposalView.js` is 912 and MUST end the client lane no longer than it starts (Task C5 removes more than it adds). `stripe.js` is 650; Task S6 adds about 12.
- Review: full pre-prod fleet on each lane before merge, `consistency-check` across the two lanes' payload seam (Task S10 produces the shape Tasks C2, C3 and C6 consume), `/second-opinion` at push.
- The two lanes touch `README.md` in different regions (server lane: `server/utils` and `stripeWebhookHandlers` tree lines near 288 and 344; client lane: `client/src/components` near 574). Read any conflict rather than taking a side.

---

# Lane `ach-server`

### Task S1: Schema, constraint manifest, and the dev database

**Files:**
- Modify: `server/db/schema.sql:2011-2012` (the `stripe_sessions_status_check` DO block) and after `server/db/schema.sql:2388` (the `idx_invoice_payments_payment_id` index, so `invoices` already exists)
- Modify: `server/db/index.js` (`CONSTRAINT_CONTRACT`, after the `shifts` entry)
- Modify: `ARCHITECTURE.md:1168-1171` (the `stripe_sessions` block)
- Test: `server/db/constraintContract.test.js` (existing; must stay green)

**Interfaces:**
- Produces: `stripe_sessions.status` accepts `'processing'`; columns `stripe_sessions.processing_at TIMESTAMPTZ NULL` and `stripe_sessions.invoice_id INTEGER NULL` (FK `invoices(id) ON DELETE SET NULL`).

- [ ] **Step 1: Widen the CHECK in place**

In `server/db/schema.sql` change the one existing definition (do not add a second):

```sql
DO $$ BEGIN
  ALTER TABLE stripe_sessions DROP CONSTRAINT IF EXISTS stripe_sessions_status_check;
  ALTER TABLE stripe_sessions ADD CONSTRAINT stripe_sessions_status_check CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled', 'processing'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;
```

- [ ] **Step 2: Add the two columns after the invoice_payments indexes**

Insert directly after the line `CREATE INDEX IF NOT EXISTS idx_invoice_payments_payment_id ON invoice_payments(payment_id);`:

```sql
-- ─── Bank debit in flight (spec 2026-09-14) ─────────────────────
-- A PaymentIntent that Stripe reports `processing` (a bank debit, four to six
-- business days to settle) is recorded on its stripe_sessions row so the
-- checkout rails, the balance reminder ladder, the client pages and the admin
-- panel can see it. The payment_intent.processing webhook is the only writer.
-- processing_at is the "started" instant every surface shows (created_at is
-- when the intent was minted, which can be earlier than the confirm).
-- invoice_id names the invoice the money is for; NULL for deposit / full /
-- drink-plan / autopay intents. Lives here, not next to the table, because
-- invoices is created later in this file and the FK needs it to exist.
ALTER TABLE stripe_sessions ADD COLUMN IF NOT EXISTS processing_at TIMESTAMPTZ;
ALTER TABLE stripe_sessions ADD COLUMN IF NOT EXISTS invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL;
```

- [ ] **Step 3: Add the manifest entry**

In `server/db/index.js`, after the `shifts` entry in `CONSTRAINT_CONTRACT`:

```js
  // Bank debit in flight (spec 2026-09-14): the payment_intent.processing
  // webhook writes 'processing' and stripeCreateIntent writes 'canceled'. A
  // narrowed definition would raise 23514 on every processing delivery, and
  // Stripe would retry it for three days against a wall.
  { table: 'stripe_sessions', constraint: 'stripe_sessions_status_check',
    mustContain: ['processing', 'canceled'] },
```

- [ ] **Step 4: Apply the schema to the shared dev database**

Run from the lane root (the lane has `.env` linked):

```bash
node -e "require('dotenv').config(); require('./server/db').initDb().then(() => { console.log('schema applied'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); })"
```

Expected: `schema applied`. Then confirm:

```bash
node -e "require('dotenv').config(); const { pool } = require('./server/db'); pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name = 'stripe_sessions' AND column_name IN ('processing_at','invoice_id')\").then(r => { console.log(r.rows); return pool.end(); })"
```

Expected: both column names listed.

- [ ] **Step 5: Run the manifest suite**

Run: `node --test server/db/constraintContract.test.js`
Expected: PASS, same count as before plus zero (the suite asserts shape, not count). If it fails on the new entry, the dev DB did not get Step 1; re-run Step 4.

- [ ] **Step 6: Update ARCHITECTURE.md**

Replace the `stripe_sessions` block at lines 1168 to 1171 with:

```markdown
**stripe_sessions** — Payment intent tracking
- `proposal_id` FK
- `stripe_payment_intent_id`, `stripe_payment_link_id`
- `amount` (cents), `status`: pending | succeeded | failed | canceled | processing
- `processing_at` (TIMESTAMPTZ, bank debit in flight, spec 2026-09-14): stamped by the `payment_intent.processing` webhook; "started" on every surface
- `invoice_id` FK→invoices (nullable, ON DELETE SET NULL): the invoice a processing payment is for; set by the invoice checkout rail at insert and by the processing webhook from intent metadata after an ownership check
```

- [ ] **Step 7: Commit**

```bash
git add server/db/schema.sql server/db/index.js ARCHITECTURE.md
git commit -F - <<'MSG'
schema(stripe_sessions): processing status, processing_at, invoice_id

Bank debit in flight, spec 2026-09-14 section 3.1.
MSG
```

---

### Task S2: `DeferMessageError` and the dispatcher's defer branch

**Files:**
- Modify: `server/utils/errors.js` (after `SuppressMessageError`, and the export list)
- Modify: `server/utils/scheduledMessageDispatcher.js:8` (import) and the catch block at lines 608 to 624 (after the `SuppressMessageError` branch)
- Test: `server/utils/scheduledMessageDispatcher.test.js` (append one test)

**Interfaces:**
- Produces: `class DeferMessageError extends Error { constructor(reason) }` with `.reason`, exported from `server/utils/errors.js`. Thrown by a handler, it lands the row in `status = 'deferred'`, `scheduled_for = NOW() + 24h`, `error_message = 'deferred: <reason>'`.

- [ ] **Step 1: Write the failing test**

Append to `server/utils/scheduledMessageDispatcher.test.js` (the file already imports `pool`, `registerHandler`, `dispatchPending`, and seeds `testProposalId` / `testClientId`; add `const { DeferMessageError } = require('./errors');` next to the other requires):

```js
test('dispatcher > DeferMessageError moves the row to deferred a day out from NOW, never failed', async () => {
  registerHandler('disp_test_defer', async () => { throw new DeferMessageError('payment_in_flight'); });
  try {
    await pool.query(
      `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
       VALUES ($1, 'proposal', 'disp_test_defer', 'client', $2, 'email', NOW() - INTERVAL '3 days')`,
      [testProposalId, testClientId]
    );
    await dispatchPending();
    const { rows } = await pool.query(
      `SELECT status, error_message, EXTRACT(EPOCH FROM (scheduled_for - NOW())) AS secs_out
         FROM scheduled_messages WHERE message_type = 'disp_test_defer'`
    );
    assert.strictEqual(rows[0].status, 'deferred');
    assert.strictEqual(rows[0].error_message, 'deferred: payment_in_flight');
    // From NOW, not from the row's own three-day-old scheduled_for: bumped from
    // its past timestamp it would be due again on the next tick and loop.
    assert.ok(Number(rows[0].secs_out) > 23 * 3600, `expected about 24h out, got ${rows[0].secs_out}s`);
    assert.ok(Number(rows[0].secs_out) <= 24 * 3600 + 60);
  } finally {
    await pool.query("DELETE FROM scheduled_messages WHERE message_type = 'disp_test_defer'");
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/utils/scheduledMessageDispatcher.test.js`
Expected: the new test FAILS (`DeferMessageError is not a constructor` or status `failed`); every other test in the file still passes.

- [ ] **Step 3: Add the error class**

In `server/utils/errors.js`, directly after the `SuppressMessageError` class:

```js
/**
 * Handler-side "right touch, wrong moment" signal (spec 2026-09-14 section 6):
 * a balance reminder while a bank debit is still processing. The dispatcher
 * moves the row to 'deferred' with scheduled_for = NOW() + 24h and its
 * reactivation pass re-queues it when due; the row is never marked suppressed
 * or failed. Plain Error subclass like SuppressMessageError: internal, never an
 * AppError, never exposed to a client. Only handlers may throw it.
 */
class DeferMessageError extends Error {
  constructor(reason) {
    super(`message deferred: ${reason}`);
    this.name = 'DeferMessageError';
    this.reason = reason;
  }
}
```

Add `DeferMessageError,` to `module.exports` after `SuppressMessageError,`.

- [ ] **Step 4: Add the dispatcher branch**

In `server/utils/scheduledMessageDispatcher.js` line 8 change the import to:

```js
const { SuppressMessageError, DeferMessageError, QuotaExceededError } = require('./errors');
```

Then in the catch block, directly after the `if (err instanceof SuppressMessageError) { ... return; }` branch and before the `QuotaExceededError` branch:

```js
    // DeferMessageError is "right touch, wrong moment" (a balance reminder while
    // a bank debit is still processing, spec 2026-09-14 section 6). Push the row
    // a day out from NOW, not from its own scheduled_for: an overdue row bumped
    // from its past timestamp would be due again on the next tick and loop. The
    // reactivation pass below flips it back to 'pending' when it comes due.
    if (err instanceof DeferMessageError) {
      const cappedReason = String(err.reason || '').slice(0, 480);
      try {
        await pool.query(
          `UPDATE scheduled_messages
              SET status = 'deferred',
                  scheduled_for = NOW() + INTERVAL '24 hours',
                  error_message = $2
            WHERE id = $1`,
          [row.id, `deferred: ${cappedReason}`]
        );
      } catch (deferErr) {
        console.error('[scheduledMessageDispatcher] failed to defer row:', deferErr.message);
        await releaseClaim(row.id);
      }
      return;
    }
```

- [ ] **Step 5: Run the suite**

Run: `node --test server/utils/scheduledMessageDispatcher.test.js`
Expected: PASS, previous count plus one. Also run `node --test server/utils/scheduledMessageDispatcher.claim.test.js` and expect PASS.

- [ ] **Step 6: Commit**

```bash
git add server/utils/errors.js server/utils/scheduledMessageDispatcher.js server/utils/scheduledMessageDispatcher.test.js
git commit -F - <<'MSG'
feat(dispatcher): DeferMessageError defers a row 24h from now

Bank debit in flight, spec 2026-09-14 section 6.
MSG
```

---

### Task S3: `paymentInFlight.js`, the one definition and the rail backstop

**Files:**
- Create: `server/utils/paymentInFlight.js`
- Test: `server/utils/paymentInFlight.test.js`

**Interfaces:**
- Produces:
  - `IN_FLIGHT_MAX_AGE_DAYS = 14`
  - `findInFlightPayments(proposalId, db = pool): Promise<Array<{ stripe_payment_intent_id: string, amount_cents: number, started_at: Date, invoice_id: number|null, invoice_number: string|null }>>` newest first
  - `toPublicPending(rows): null | { amount_cents, started_at, invoice_id, invoice_number }` (newest row, intent id stripped)
  - `inFlightMessage({ amountCents, startedAt, timeZone }): string` (the 409 copy)
  - `assertNoInFlightPayment({ proposalId, timeZone, db = pool }): Promise<void>` throws `ConflictError(message, 'PAYMENT_IN_FLIGHT')`
  - `assertNoIntentSettlingAtStripe({ proposalId, stripe, timeZone, db = pool }): Promise<void>` throws `ConflictError(..., 'PAYMENT_IN_FLIGHT')` or `ExternalServiceError('Stripe', err, 'Payment temporarily unavailable. Please try again.')`

- [ ] **Step 1: Write the failing tests**

```js
// server/utils/paymentInFlight.test.js
require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const {
  IN_FLIGHT_MAX_AGE_DAYS, findInFlightPayments, toPublicPending, inFlightMessage,
  assertNoInFlightPayment, assertNoIntentSettlingAtStripe,
} = require('./paymentInFlight');

if (process.env.NODE_ENV === 'production') {
  throw new Error('paymentInFlight.test.js refuses to run against production');
}

const MARK = `pif-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let clientId, proposalId, invoiceId;

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('In Flight Test', $1) RETURNING id`, [`${MARK}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid, pricing_snapshot, event_timezone)
     VALUES ($1, 'deposit_paid', 'wedding', 500, 100, '{}'::jsonb, 'America/Chicago') RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  const i = await pool.query(
    `INSERT INTO invoices (proposal_id, token, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, $3, 'Balance', 40000, 0, 'sent') RETURNING id`,
    [proposalId, crypto.randomUUID(), `INV-${MARK}`]
  );
  invoiceId = i.rows[0].id;
});

beforeEach(async () => {
  await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

async function seed({ intentId, status = 'processing', amount = 40000, processingAgo = '1 hour', createdAgo = '1 hour', invoice = null }) {
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at, invoice_id, created_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'processing' THEN NOW() - $5::interval ELSE NULL END, $6, NOW() - $7::interval)`,
    [proposalId, intentId, amount, status, processingAgo, invoice, createdAgo]
  );
}

function fakeStripe(byId, { failWith } = {}) {
  return { paymentIntents: { retrieve: async (id) => {
    if (failWith) throw failWith;
    if (!byId[id]) { const e = new Error('No such payment_intent'); e.code = 'resource_missing'; throw e; }
    return byId[id];
  } } };
}

test('findInFlightPayments > a processing row inside the window is returned with its invoice number, newest first', async () => {
  await seed({ intentId: `pi_${MARK}_old`, processingAgo: '2 days', invoice: invoiceId });
  await seed({ intentId: `pi_${MARK}_new`, processingAgo: '1 hour', amount: 12300 });
  const rows = await findInFlightPayments(proposalId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].stripe_payment_intent_id, `pi_${MARK}_new`);
  assert.equal(rows[0].amount_cents, 12300);
  assert.equal(rows[0].invoice_id, null);
  assert.equal(rows[1].invoice_id, invoiceId);
  assert.equal(rows[1].invoice_number, `INV-${MARK}`);
  assert.ok(rows[0].started_at instanceof Date);
});

test('findInFlightPayments > pending, succeeded, failed and canceled rows are never in flight', async () => {
  for (const status of ['pending', 'succeeded', 'failed', 'canceled']) {
    await seed({ intentId: `pi_${MARK}_${status}`, status });
  }
  assert.deepEqual(await findInFlightPayments(proposalId), []);
});

test(`findInFlightPayments > a processing row older than ${IN_FLIGHT_MAX_AGE_DAYS} days has expired (D6)`, async () => {
  await seed({ intentId: `pi_${MARK}_stale`, processingAgo: `${IN_FLIGHT_MAX_AGE_DAYS + 1} days` });
  assert.deepEqual(await findInFlightPayments(proposalId), []);
});

test('toPublicPending > newest row without the intent id, null when empty', () => {
  assert.equal(toPublicPending([]), null);
  const started = new Date('2026-09-05T16:05:35Z');
  const out = toPublicPending([{ stripe_payment_intent_id: 'pi_x', amount_cents: 40000, started_at: started, invoice_id: 363, invoice_number: 'INV-0363' }]);
  assert.deepEqual(out, { amount_cents: 40000, started_at: started, invoice_id: 363, invoice_number: 'INV-0363' });
  assert.equal('stripe_payment_intent_id' in out, false);
});

test('inFlightMessage > dollars, long date in the event timezone, no em dash', () => {
  const msg = inFlightMessage({ amountCents: 40000, startedAt: new Date('2026-09-05T16:05:35Z'), timeZone: 'America/Chicago' });
  assert.equal(msg, 'A $400.00 payment for this event has been processing since September 5. Bank payments take four to six business days to clear, and you will get a receipt by email when it does. If you think this is a mistake, email contact@drbartender.com.');
  assert.ok(!msg.includes('—'));
  const noDate = inFlightMessage({ amountCents: 10000, startedAt: null, timeZone: 'America/Chicago' });
  assert.ok(noDate.startsWith('A $100.00 payment for this event has been processing. '));
});

test('assertNoInFlightPayment > throws 409 PAYMENT_IN_FLIGHT on a processing row, resolves otherwise', async () => {
  await assertNoInFlightPayment({ proposalId, timeZone: 'America/Chicago' });
  await seed({ intentId: `pi_${MARK}_block` });
  await assert.rejects(
    assertNoInFlightPayment({ proposalId, timeZone: 'America/Chicago' }),
    (err) => err.statusCode === 409 && err.code === 'PAYMENT_IN_FLIGHT' && /\$400\.00/.test(err.message)
  );
});

test('assertNoIntentSettlingAtStripe > a pending row Stripe reports processing or succeeded is a 409', async () => {
  for (const status of ['processing', 'succeeded']) {
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [proposalId]);
    const id = `pi_${MARK}_stripe_${status}`;
    await seed({ intentId: id, status: 'pending' });
    const stripe = fakeStripe({ [id]: { id, status, amount: 40000, created: Math.floor(Date.now() / 1000) } });
    await assert.rejects(
      assertNoIntentSettlingAtStripe({ proposalId, stripe, timeZone: 'America/Chicago' }),
      (err) => err.statusCode === 409 && err.code === 'PAYMENT_IN_FLIGHT'
    );
  }
});

test('assertNoIntentSettlingAtStripe > requires_payment_method and resource_missing pass; at most 5 recent rows are read', async () => {
  const seen = [];
  const byId = {};
  for (let n = 0; n < 7; n += 1) {
    const id = `pi_${MARK}_many_${n}`;
    await seed({ intentId: id, status: 'pending', createdAgo: `${n + 1} minutes` });
    if (n % 2 === 0) byId[id] = { id, status: 'requires_payment_method', amount: 40000 };
  }
  const stripe = { paymentIntents: { retrieve: async (id) => {
    seen.push(id);
    if (!byId[id]) { const e = new Error('No such payment_intent'); e.code = 'resource_missing'; throw e; }
    return byId[id];
  } } };
  await assertNoIntentSettlingAtStripe({ proposalId, stripe, timeZone: 'America/Chicago' });
  assert.equal(seen.length, 5, 'bounded scan');
  assert.ok(!seen.includes(`pi_${MARK}_many_6`), 'the oldest rows fall outside the window of five');
});

test('assertNoIntentSettlingAtStripe > a pending row older than the window is not read', async () => {
  const id = `pi_${MARK}_ancient`;
  await seed({ intentId: id, status: 'pending', createdAgo: `${IN_FLIGHT_MAX_AGE_DAYS + 1} days` });
  const stripe = fakeStripe({ [id]: { id, status: 'processing', amount: 40000 } });
  await assertNoIntentSettlingAtStripe({ proposalId, stripe, timeZone: 'America/Chicago' });
});

test('assertNoIntentSettlingAtStripe > any retrieve failure other than resource_missing fails closed as a 503 (D7)', async () => {
  const id = `pi_${MARK}_down`;
  await seed({ intentId: id, status: 'pending' });
  const boom = new Error('connection reset'); boom.code = 'ECONNRESET';
  await assert.rejects(
    assertNoIntentSettlingAtStripe({ proposalId, stripe: fakeStripe({}, { failWith: boom }), timeZone: 'America/Chicago' }),
    (err) => err.statusCode === 503 && /temporarily unavailable/.test(err.message)
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/utils/paymentInFlight.test.js`
Expected: FAIL, `Cannot find module './paymentInFlight'`.

- [ ] **Step 3: Write the module**

```js
// server/utils/paymentInFlight.js
'use strict';
/**
 * Bank debit in flight (spec 2026-09-14 section 3.2). ONE definition of "a
 * payment on this proposal is still settling", read by both checkout rails,
 * the balance reminder ladder, the public invoice and proposal payloads and
 * the admin payment panel. Nothing else reads stripe_sessions.status =
 * 'processing' directly.
 *
 * The row state is written by the payment_intent.processing webhook
 * (routes/stripeWebhookHandlers/paymentIntentProcessing.js) and released by
 * the succeeded and payment_failed handlers. IN_FLIGHT_MAX_AGE_DAYS is the
 * backstop for a lost failed event: a processing row can never lock an
 * invoice forever (D6).
 */
const { pool } = require('../db');
const { ConflictError, ExternalServiceError } = require('./errors');

const IN_FLIGHT_MAX_AGE_DAYS = 14;
// Mirrors publicSwitch.js: the SDK default is 80s with retries, far too long
// for a request a client is waiting on.
const STRIPE_CALL_TIMEOUT_MS = 10000;
// The webhook-independent backstop reads at most this many recent pending
// intents from Stripe per checkout click, newest first, in parallel.
const BACKSTOP_SCAN_LIMIT = 5;

async function findInFlightPayments(proposalId, db = pool) {
  const { rows } = await db.query(
    `SELECT s.stripe_payment_intent_id,
            s.amount AS amount_cents,
            s.processing_at AS started_at,
            s.invoice_id,
            i.invoice_number
       FROM stripe_sessions s
       LEFT JOIN invoices i ON i.id = s.invoice_id
      WHERE s.proposal_id = $1
        AND s.status = 'processing'
        AND s.processing_at > NOW() - INTERVAL '${IN_FLIGHT_MAX_AGE_DAYS} days'
      ORDER BY s.processing_at DESC`,
    [proposalId]
  );
  return rows.map((r) => ({
    stripe_payment_intent_id: r.stripe_payment_intent_id,
    amount_cents: Number(r.amount_cents),
    started_at: r.started_at,
    invoice_id: r.invoice_id == null ? null : Number(r.invoice_id),
    invoice_number: r.invoice_number || null,
  }));
}

// The public shape (spec section 7): the newest in-flight payment, intent id
// stripped. Identical on every public route.
function toPublicPending(rows) {
  if (!rows || !rows[0]) return null;
  const { amount_cents, started_at, invoice_id, invoice_number } = rows[0];
  return { amount_cents, started_at, invoice_id, invoice_number };
}

// The 409 copy (spec section 5.1). No em dashes.
function inFlightMessage({ amountCents, startedAt, timeZone }) {
  const dollars = `$${(Number(amountCents || 0) / 100).toFixed(2)}`;
  let since = '';
  if (startedAt) {
    const d = new Date(startedAt);
    if (!Number.isNaN(d.getTime())) {
      since = ` since ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: timeZone || 'America/Chicago' })}`;
    }
  }
  return `A ${dollars} payment for this event has been processing${since}. `
    + 'Bank payments take four to six business days to clear, and you will get a receipt by email when it does. '
    + 'If you think this is a mistake, email contact@drbartender.com.';
}

// Rail guard, DB side. Any in-flight payment on the proposal blocks (D3).
async function assertNoInFlightPayment({ proposalId, timeZone, db = pool }) {
  const rows = await findInFlightPayments(proposalId, db);
  if (!rows[0]) return;
  throw new ConflictError(
    inFlightMessage({ amountCents: rows[0].amount_cents, startedAt: rows[0].started_at, timeZone }),
    'PAYMENT_IN_FLIGHT'
  );
}

// Rail guard, Stripe side: the backstop that does not depend on the
// processing webhook (the seconds before it lands, the hours before the
// subscription is live, a dropped delivery). Reads the newest recent pending
// intents and asks Stripe. Unknown is not "nothing in flight": any failure
// other than resource_missing fails closed (D7), the same rule as the autopay
// guard and the option switch.
async function assertNoIntentSettlingAtStripe({ proposalId, stripe, timeZone, db = pool }) {
  const { rows } = await db.query(
    `SELECT stripe_payment_intent_id
       FROM stripe_sessions
      WHERE proposal_id = $1
        AND status = 'pending'
        AND stripe_payment_intent_id IS NOT NULL
        AND created_at > NOW() - INTERVAL '${IN_FLIGHT_MAX_AGE_DAYS} days'
      ORDER BY created_at DESC
      LIMIT ${BACKSTOP_SCAN_LIMIT}`,
    [proposalId]
  );
  if (!rows.length) return;
  const intents = await Promise.all(rows.map(async (row) => {
    try {
      return await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id, { timeout: STRIPE_CALL_TIMEOUT_MS });
    } catch (err) {
      if (err && err.code === 'resource_missing') return null;
      throw new ExternalServiceError('Stripe', err, 'Payment temporarily unavailable. Please try again.');
    }
  }));
  const settling = intents.find((i) => i && (i.status === 'processing' || i.status === 'succeeded'));
  if (!settling) return;
  throw new ConflictError(
    inFlightMessage({
      amountCents: settling.amount,
      startedAt: settling.status === 'processing' && settling.created ? new Date(settling.created * 1000) : null,
      timeZone,
    }),
    'PAYMENT_IN_FLIGHT'
  );
}

module.exports = {
  IN_FLIGHT_MAX_AGE_DAYS,
  findInFlightPayments,
  toPublicPending,
  inFlightMessage,
  assertNoInFlightPayment,
  assertNoIntentSettlingAtStripe,
};
```

- [ ] **Step 4: Run the tests**

Run: `node --test server/utils/paymentInFlight.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/paymentInFlight.js server/utils/paymentInFlight.test.js
git commit -F - <<'MSG'
feat(payments): paymentInFlight helper, the one in-flight definition

Bank debit in flight, spec 2026-09-14 section 3.2.
MSG
```

---

### Task S4: The client email template and notifier

**Files:**
- Modify: `server/utils/lifecycleEmailTemplates.js` (new function before `module.exports`, plus the export)
- Modify: `server/utils/emailTemplates.js` (one re-export line in the lifecycle block near line 892)
- Create: `server/utils/bankPaymentProcessingNotify.js`
- Test: `server/utils/bankPaymentProcessingNotify.test.js`

**Interfaces:**
- Produces:
  - `bankPaymentProcessingClient({ clientName, amountCents, paymentType, eventTypeLabel, eventDate, proposalUrl }): { subject, html, text }`
  - `notifyClientBankPaymentProcessing({ proposalId, amountCents, paymentType }): Promise<{ sent: boolean, reason?: string }>` never throws

- [ ] **Step 1: Write the failing tests**

```js
// server/utils/bankPaymentProcessingNotify.test.js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { bankPaymentProcessingClient } = require('./lifecycleEmailTemplates');
const emailTemplates = require('./emailTemplates');
const { notifyClientBankPaymentProcessing } = require('./bankPaymentProcessingNotify');

if (process.env.NODE_ENV === 'production') {
  throw new Error('bankPaymentProcessingNotify.test.js refuses to run against production');
}

const MARK = `bpn-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const clientIds = [];
const proposalIds = [];

async function seed({ emailStatus = 'ok', email = `${MARK}-${clientIds.length}@example.com` } = {}) {
  const c = await pool.query(
    `INSERT INTO clients (name, email, email_status) VALUES ('Bank Notify Test', $1, $2) RETURNING id`,
    [email, emailStatus]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid, pricing_snapshot, token, event_date, event_timezone)
     VALUES ($1, 'deposit_paid', 'Cocktail Party', 500, 100, '{}'::jsonb, $2, DATE '2026-09-19', 'America/Chicago') RETURNING id`,
    [c.rows[0].id, crypto.randomUUID()]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

after(async () => {
  if (proposalIds.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('bankPaymentProcessingClient > subject, dollars, noun, the clearing line, no em dash', () => {
  const t = bankPaymentProcessingClient({
    clientName: 'Thekla Eftychiadou', amountCents: 40000, paymentType: 'invoice',
    eventTypeLabel: 'Cocktail Party', eventDate: 'Saturday, September 19', proposalUrl: 'https://drbartender.com/proposal/x',
  });
  assert.equal(t.subject, 'We received your bank payment');
  assert.match(t.html, /\$400\.00/);
  assert.match(t.html, /payment<\/strong> for your <strong>Cocktail Party<\/strong> on Saturday, September 19/);
  assert.match(t.text, /four to six business days to clear/);
  assert.match(t.text, /nothing more is needed from you/);
  assert.ok(!t.html.includes('—') && !t.text.includes('—'));
  const dep = bankPaymentProcessingClient({ clientName: 'A', amountCents: 10000, paymentType: 'deposit', eventTypeLabel: 'event', eventDate: null, proposalUrl: 'u' });
  assert.match(dep.text, /\$100\.00 deposit for your event\./);
  assert.equal(emailTemplates.bankPaymentProcessingClient, bankPaymentProcessingClient, 're-exported for property access');
});

test('notifyClientBankPaymentProcessing > sends (logged only under the test flag) for a good address', async () => {
  const id = await seed();
  const r = await notifyClientBankPaymentProcessing({ proposalId: id, amountCents: 40000, paymentType: 'invoice' });
  assert.deepEqual(r, { sent: true });
});

test('notifyClientBankPaymentProcessing > a bad address is skipped the way the receipt skips it', async () => {
  const id = await seed({ emailStatus: 'bad' });
  const r = await notifyClientBankPaymentProcessing({ proposalId: id, amountCents: 40000, paymentType: 'invoice' });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'bad_contact');
});

test('notifyClientBankPaymentProcessing > never throws: an unknown proposal resolves sent:false', async () => {
  const r = await notifyClientBankPaymentProcessing({ proposalId: -1, amountCents: 1, paymentType: 'deposit' });
  assert.equal(r.sent, false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/utils/bankPaymentProcessingNotify.test.js`
Expected: FAIL, `Cannot find module './bankPaymentProcessingNotify'`.

- [ ] **Step 3: Add the template**

In `server/utils/lifecycleEmailTemplates.js`, before `module.exports`:

```js
/**
 * Bank debit in flight (spec 2026-09-14 section 9). Sent once when Stripe
 * reports a client's PaymentIntent `processing`. A bank debit takes four to
 * six business days to clear and NO receipt goes out until it does, so this
 * is the only thing the client hears in that window. amountCents is cents.
 * paymentType 'deposit' reads "deposit"; everything else reads "payment".
 * eventDate is already formatted (or null). No em dashes.
 */
function bankPaymentProcessingClient({ clientName, amountCents, paymentType, eventTypeLabel = 'event', eventDate, proposalUrl }) {
  const name = clientName || 'there';
  const dollars = `$${(Number(amountCents || 0) / 100).toFixed(2)}`;
  const noun = paymentType === 'deposit' ? 'deposit' : 'payment';
  const dateHtml = eventDate ? ` on ${esc(eventDate)}` : '';
  const dateText = eventDate ? ` on ${eventDate}` : '';
  return {
    subject: 'We received your bank payment',
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Bank Payment Received</h2>
      <p>Hi ${esc(firstNameOf(name))},</p>
      <p>We received your <strong>${dollars}</strong> ${noun} for your <strong>${esc(eventTypeLabel)}</strong>${dateHtml}. It is a bank payment, so it is still processing.</p>
      <p>Bank payments take four to six business days to clear. You will get a receipt by email when it does, and nothing more is needed from you.</p>
      ${ctaButton(proposalUrl, 'View your proposal')}
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
      <p>Cheers, Dallas</p>
    `),
    text: `Hi ${firstNameOf(name)}, we received your ${dollars} ${noun} for your ${eventTypeLabel}${dateText}. It is a bank payment, so it is still processing. Bank payments take four to six business days to clear. You will get a receipt by email when it does, and nothing more is needed from you. View your proposal: ${proposalUrl}. Cheers, Dallas`,
  };
}
```

Add `bankPaymentProcessingClient,` to that file's `module.exports`. In `server/utils/emailTemplates.js`, in the "Lifecycle templates re-exported" block, add:

```js
  bankPaymentProcessingClient: lifecycle.bankPaymentProcessingClient,
```

- [ ] **Step 4: Write the notifier**

```js
// server/utils/bankPaymentProcessingNotify.js
'use strict';
// Client-facing "we received your bank payment" email (spec 2026-09-14
// section 9). Post-commit, best effort: owns its try/catch and never throws
// into the webhook handler. Email only, no SMS (Dallas, 2026-09-14). Gated
// the same way the payment receipt is (stripePaymentNotifications.js):
// shouldSendImmediate with the client's email_status and preferences, so a bad
// address gets nothing, as today. Takes its own pooled connection, so it must
// run AFTER the handler has released its transaction client.
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { bankPaymentProcessingClient } = require('./lifecycleEmailTemplates');
const { shouldSendImmediate } = require('./messageSuppression');
const { getEventTypeLabel } = require('./eventTypes');
const { proposalUrl } = require('./urls');
const { formatEventDateLong } = require('./staffShiftHandlers');

async function notifyClientBankPaymentProcessing({ proposalId, amountCents, paymentType }) {
  try {
    const { rows } = await pool.query(
      `SELECT p.token, p.status, p.event_type, p.event_type_custom, p.event_date, p.event_timezone,
              c.id AS client_id, c.name AS client_name, c.email AS client_email,
              c.communication_preferences, c.email_status, c.phone_status
         FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1`,
      [proposalId]
    );
    const pc = rows[0];
    if (!pc || !pc.client_email) return { sent: false, reason: 'no_email' };
    const check = await shouldSendImmediate({
      proposal: { id: proposalId, status: pc.status },
      client: {
        id: pc.client_id,
        communication_preferences: pc.communication_preferences,
        email_status: pc.email_status,
        phone_status: pc.phone_status,
      },
      channel: 'email',
    });
    if (!check.ok) return { sent: false, reason: check.reason };
    const eventDate = pc.event_date
      ? formatEventDateLong({ event_date: pc.event_date, event_timezone: pc.event_timezone })
      : null;
    const tpl = bankPaymentProcessingClient({
      clientName: pc.client_name,
      amountCents,
      paymentType,
      eventTypeLabel: getEventTypeLabel({ event_type: pc.event_type, event_type_custom: pc.event_type_custom }),
      eventDate: eventDate === 'your event' ? null : eventDate,
      proposalUrl: proposalUrl(pc.token),
    });
    await sendEmail({ to: pc.client_email, ...tpl });
    return { sent: true };
  } catch (err) {
    console.error('notifyClientBankPaymentProcessing failed (non-blocking):', err && err.message);
    return { sent: false, reason: 'error' };
  }
}

module.exports = { notifyClientBankPaymentProcessing };
```

- [ ] **Step 5: Run the tests**

Run: `node --test server/utils/bankPaymentProcessingNotify.test.js`
Expected: PASS, 4 tests. If the "good address" test returns `sent:false, reason:'error'`, read the console line above it: `formatEventDateLong` and `proposalUrl` are the two imports to check.

- [ ] **Step 6: Commit**

```bash
git add server/utils/lifecycleEmailTemplates.js server/utils/emailTemplates.js server/utils/bankPaymentProcessingNotify.js server/utils/bankPaymentProcessingNotify.test.js
git commit -F - <<'MSG'
feat(email): bank payment received email for a processing debit

Bank debit in flight, spec 2026-09-14 section 9. Email only, no SMS.
MSG
```

---

### Task S5: The `payment_intent.processing` webhook handler

**Files:**
- Create: `server/routes/stripeWebhookHandlers/paymentIntentProcessing.js`
- Modify: `server/routes/stripeWebhook.js` (one require near line 16, one dispatch block after the `payment_intent.succeeded` block)
- Test: `server/routes/stripeWebhook.processing.test.js`

**Interfaces:**
- Consumes: `notifyClientBankPaymentProcessing` (Task S4).
- Produces: `module.exports = async function handlePaymentIntentProcessing(event): Promise<void>`; writes `stripe_sessions.status = 'processing'`, `processing_at`, `invoice_id`, and one `proposal_activity_log` row `action = 'payment_processing'` per transition.

- [ ] **Step 1: Write the failing tests**

```js
// server/routes/stripeWebhook.processing.test.js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const WEBHOOK_SECRET = 'whsec_test_processing';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_WEBHOOK_SECRET_TEST = '';
process.env.STRIPE_TEST_MODE_UNTIL = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const stripeRouter = require('./stripe');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripeWebhook.processing.test.js refuses to run against production');
}

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
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'stripe-signature': sig } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }
    );
    r.on('error', reject);
    r.write(buf);
    r.end();
  });
}

async function seedProposal() {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('WH Processing', $1) RETURNING id`,
    [`wh-proc-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, pricing_snapshot, event_timezone)
     VALUES ($1, 'deposit_paid', 500, 100, 100, '{}'::jsonb, 'America/Chicago') RETURNING id`,
    [c.rows[0].id]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

async function seedInvoice(proposalId) {
  const r = await pool.query(
    `INSERT INTO invoices (proposal_id, token, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, $3, 'Balance', 40000, 0, 'sent') RETURNING id`,
    [proposalId, crypto.randomUUID(), `INV-${NONCE}-${proposalId}`]
  );
  return r.rows[0].id;
}

async function seedSession(proposalId, piId, status = 'pending') {
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 40000, $3)`,
    [proposalId, piId, status]
  );
}

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

function processingEvent({ id, piId, proposalId, invoiceId, livemode = true }) {
  return {
    id, type: 'payment_intent.processing', livemode,
    data: { object: {
      id: piId, object: 'payment_intent', amount: 40000, status: 'processing',
      metadata: { proposal_id: String(proposalId), payment_type: 'invoice', ...(invoiceId ? { invoice_id: String(invoiceId) } : {}) },
    } },
  };
}

before(async () => {
  const app = express();
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/stripe', stripeRouter);
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => setTimeout(r, 300));
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('processing flips a pending row, stamps processing_at and an owned invoice_id, logs once', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p);
  const piId = `pi_${NONCE}_flip`;
  await seedSession(p, piId);

  const r = await postWebhook(processingEvent({ id: `evt_${NONCE}_flip`, piId, proposalId: p, invoiceId: inv }));
  assert.equal(r.status, 200, r.body);

  const sess = await one('SELECT status, processing_at, invoice_id FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.status, 'processing');
  assert.ok(sess.processing_at, 'processing_at stamped');
  assert.equal(Number(sess.invoice_id), inv);

  const log = await one(`SELECT COUNT(*)::int AS n, MAX(details->>'invoice_id') AS inv FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'payment_processing'`, [p]);
  assert.equal(log.n, 1);
  assert.equal(Number(log.inv), inv);
});

test('a redelivery is a no-op: status unchanged, still exactly one activity row', async () => {
  const p = await seedProposal();
  const piId = `pi_${NONCE}_redeliver`;
  await seedSession(p, piId);
  await postWebhook(processingEvent({ id: `evt_${NONCE}_rd1`, piId, proposalId: p }));
  const first = await one('SELECT processing_at FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  await new Promise((r) => setTimeout(r, 20));
  const r = await postWebhook(processingEvent({ id: `evt_${NONCE}_rd2`, piId, proposalId: p }));
  assert.equal(r.status, 200);
  const again = await one('SELECT status, processing_at FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(again.status, 'processing');
  assert.equal(String(again.processing_at), String(first.processing_at), 'processing_at not restamped');
  const log = await one(`SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'payment_processing'`, [p]);
  assert.equal(log.n, 1);
});

test('a processing event after succeeded never downgrades the row', async () => {
  const p = await seedProposal();
  const piId = `pi_${NONCE}_late`;
  await seedSession(p, piId, 'succeeded');
  const r = await postWebhook(processingEvent({ id: `evt_${NONCE}_late`, piId, proposalId: p }));
  assert.equal(r.status, 200);
  const sess = await one('SELECT status, processing_at FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.status, 'succeeded');
  assert.equal(sess.processing_at, null);
  const log = await one(`SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'payment_processing'`, [p]);
  assert.equal(log.n, 0);
});

test('an invoice_id that belongs to another proposal is stored as NULL', async () => {
  const p = await seedProposal();
  const other = await seedProposal();
  const foreignInv = await seedInvoice(other);
  const piId = `pi_${NONCE}_foreign`;
  await seedSession(p, piId);
  await postWebhook(processingEvent({ id: `evt_${NONCE}_foreign`, piId, proposalId: p, invoiceId: foreignInv }));
  const sess = await one('SELECT status, invoice_id FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.status, 'processing');
  assert.equal(sess.invoice_id, null);
});

test('a missing row is inserted as processing so the guard can see an intent minted outside the app', async () => {
  const p = await seedProposal();
  const piId = `pi_${NONCE}_missing`;
  const r = await postWebhook(processingEvent({ id: `evt_${NONCE}_missing`, piId, proposalId: p }));
  assert.equal(r.status, 200);
  const sess = await one('SELECT proposal_id, amount, status, processing_at FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(Number(sess.proposal_id), p);
  assert.equal(Number(sess.amount), 40000);
  assert.equal(sess.status, 'processing');
  assert.ok(sess.processing_at);
});

test('a livemode:false event outside a test window is dropped by the dispatcher gate', async () => {
  const p = await seedProposal();
  const piId = `pi_${NONCE}_testmode`;
  await seedSession(p, piId);
  const r = await postWebhook(processingEvent({ id: `evt_${NONCE}_testmode`, piId, proposalId: p, livemode: false }));
  assert.equal(r.status, 200);
  assert.match(r.body, /test_mode/);
  const sess = await one('SELECT status FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.status, 'pending');
});

test('an event with no proposal_id is acked and writes nothing', async () => {
  const piId = `pi_${NONCE}_noprop`;
  const r = await postWebhook({
    id: `evt_${NONCE}_noprop`, type: 'payment_intent.processing', livemode: true,
    data: { object: { id: piId, object: 'payment_intent', amount: 100, status: 'processing', metadata: {} } },
  });
  assert.equal(r.status, 200);
  const sess = await one('SELECT COUNT(*)::int AS n FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.n, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/routes/stripeWebhook.processing.test.js`
Expected: the first five tests FAIL (rows stay `pending`, no activity rows); the test-mode and no-proposal tests may already pass because the dispatcher acks unknown events.

- [ ] **Step 3: Write the handler**

```js
// server/routes/stripeWebhookHandlers/paymentIntentProcessing.js
// stripeWebhook concern: payment_intent.processing (spec 2026-09-14 section
// 4.1). A bank debit confirms into `processing` and settles four to six
// business days later. This handler is the ONLY writer of
// stripe_sessions.status = 'processing'; the succeeded and payment_failed
// handlers release it. Every consumer reads it through
// utils/paymentInFlight.js.
//
// Idempotency is the row's own state: only a still-pending row moves, so a
// redelivery, or a processing event delivered after succeeded or
// payment_failed, matches nothing and changes nothing. One activity row per
// real transition. The client email runs post-commit, after release.
const { pool } = require('../../db');
const { notifyClientBankPaymentProcessing } = require('../../utils/bankPaymentProcessingNotify');

module.exports = async function handlePaymentIntentProcessing(event) {
  const intent = event.data.object;
  const proposalId = Number(intent.metadata?.proposal_id);
  if (!Number.isInteger(proposalId) || proposalId <= 0) return;
  const paymentType = intent.metadata?.payment_type || 'deposit';
  const metaInvoiceId = Number(intent.metadata?.invoice_id);
  const amountCents = Number(intent.amount) || 0;

  const dbClient = await pool.connect();
  let transitioned = false;
  try {
    await dbClient.query('BEGIN');

    // Ownership check, the same rule as the succeeded handler's invoice link:
    // an invoice id that does not belong to this proposal is stored as NULL.
    let invoiceId = null;
    if (Number.isInteger(metaInvoiceId) && metaInvoiceId > 0) {
      const own = await dbClient.query(
        'SELECT id FROM invoices WHERE id = $1 AND proposal_id = $2',
        [metaInvoiceId, proposalId]
      );
      if (own.rows[0]) invoiceId = metaInvoiceId;
    }

    const upd = await dbClient.query(
      `UPDATE stripe_sessions
          SET status = 'processing', processing_at = NOW(), invoice_id = COALESCE($2, invoice_id)
        WHERE stripe_payment_intent_id = $1 AND status = 'pending'
        RETURNING id`,
      [intent.id, invoiceId]
    );
    transitioned = upd.rowCount === 1;

    if (!transitioned) {
      // No pending row. Either the intent was already released (redelivery,
      // or processing delivered after succeeded), in which case the unique
      // index makes this a no-op, or the intent was minted outside the app
      // and still carries our metadata, in which case the guard must see it.
      const ins = await dbClient.query(
        `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at, invoice_id)
         VALUES ($1, $2, $3, 'processing', NOW(), $4)
         ON CONFLICT (stripe_payment_intent_id) DO NOTHING
         RETURNING id`,
        [proposalId, intent.id, amountCents, invoiceId]
      );
      transitioned = ins.rowCount === 1;
    }

    if (transitioned) {
      await dbClient.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'payment_processing', 'system', $2)`,
        [proposalId, JSON.stringify({ amount: amountCents, payment_intent_id: intent.id, payment_type: paymentType, invoice_id: invoiceId })]
      );
    }
    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (_) { /* connection already dead */ }
    throw err;
  } finally {
    dbClient.release();
  }

  // Post-commit, after release: the notifier takes its own pooled connection
  // (one pooled connection per request). Fire and forget, like the receipt.
  if (transitioned) {
    notifyClientBankPaymentProcessing({ proposalId, amountCents, paymentType })
      .catch((err) => console.error('bank payment processing notify failed (non-blocking):', err && err.message));
  }
};
```

- [ ] **Step 4: Wire the dispatcher**

In `server/routes/stripeWebhook.js`, after `const handlePaymentIntentSucceeded = require(...)` add:

```js
const handlePaymentIntentProcessing = require('./stripeWebhookHandlers/paymentIntentProcessing');
```

After the `payment_intent.succeeded` dispatch block add:

```js
  // Bank debit in flight (spec 2026-09-14): a processing intent is recorded so
  // the rails, the reminder ladder and the client pages can see it. Idempotent
  // on the row's own pending state; nothing to early-ack.
  if (event.type === 'payment_intent.processing') {
    await handlePaymentIntentProcessing(event);
    if (res.headersSent) return;
  }
```

- [ ] **Step 5: Run the suites**

Run: `node --test server/routes/stripeWebhook.processing.test.js`
Expected: PASS, 7 tests.

Run each of: `node --test server/routes/stripeWebhook.guards.test.js`, `node --test server/routes/stripe.webhook.test.js`, `node --test server/routes/stripeWebhook.invoiceLink.test.js`, `node --test server/routes/stripeWebhook.balanceBranch.test.js`
Expected: PASS, unchanged counts.

- [ ] **Step 6: Commit**

```bash
git add server/routes/stripeWebhookHandlers/paymentIntentProcessing.js server/routes/stripeWebhook.js server/routes/stripeWebhook.processing.test.js
git commit -F - <<'MSG'
feat(webhook): record payment_intent.processing on stripe_sessions

Bank debit in flight, spec 2026-09-14 section 4.1.
MSG
```

---

### Task S6: The invoice rail refuses while a payment is in flight

**Files:**
- Modify: `server/routes/stripe.js:538-640` (`create-intent-for-invoice`)
- Test: `server/routes/stripe.invoiceIntentInFlight.test.js`

**Interfaces:**
- Consumes: `assertNoInFlightPayment`, `assertNoIntentSettlingAtStripe` (Task S3).
- Produces: 409 `PAYMENT_IN_FLIGHT` before any Stripe create; the `stripe_sessions` insert carries `invoice_id`.

- [ ] **Step 1: Write the failing tests**

```js
// server/routes/stripe.invoiceIntentInFlight.test.js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
process.env.STRIPE_TEST_MODE_UNTIL = '';

const createCalls = [];
const scripted = new Map(); // intent id -> object returned by retrieve
let retrieveFailure = null;
const fakeStripe = {
  customers: {
    retrieve: async (id) => ({ id, deleted: false }),
    create: async () => ({ id: `cus_fake_${Date.now()}` }),
  },
  paymentIntents: {
    create: async (params) => {
      createCalls.push(params);
      return { id: `pi_fake_${Date.now()}_${createCalls.length}`, client_secret: `secret_${createCalls.length}` };
    },
    retrieve: async (id) => {
      if (retrieveFailure) throw retrieveFailure;
      if (scripted.has(id)) return scripted.get(id);
      const e = new Error(`No such payment_intent: ${id}`); e.code = 'resource_missing'; throw e;
    },
  },
};
require('../utils/stripeClient').getStripe = () => fakeStripe;

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const stripeRouter = require('./stripe');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripe.invoiceIntentInFlight.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
const proposalIds = [];
const clientIds = [];

async function seedProposal() {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Invoice In Flight', $1) RETURNING id`,
    [`inv-flight-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, event_type, pricing_snapshot, stripe_customer_id, event_timezone)
     VALUES ($1, 'deposit_paid', 500, 100, 'wedding', '{}'::jsonb, 'cus_faketest', 'America/Chicago') RETURNING id`,
    [c.rows[0].id]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

async function seedInvoice(proposalId) {
  const token = crypto.randomUUID();
  const r = await pool.query(
    `INSERT INTO invoices (proposal_id, token, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, $3, 'Balance', 40000, 0, 'sent') RETURNING id`,
    [proposalId, token, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  return { token, id: r.rows[0].id };
}

function post(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j, raw: b }); }); }
    );
    r.on('error', reject);
    r.write('{}');
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use('/api/stripe', express.json());
  app.use('/api/stripe', stripeRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => { createCalls.length = 0; scripted.clear(); retrieveFailure = null; });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('a processing row on the proposal refuses with 409 PAYMENT_IN_FLIGHT before any Stripe call', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p);
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at, invoice_id)
     VALUES ($1, $2, 40000, 'processing', NOW() - INTERVAL '2 days', $3)`,
    [p, `pi_${NONCE}_proc`, inv.id]
  );
  const r = await post(`/api/stripe/create-intent-for-invoice/${inv.token}`);
  assert.equal(r.status, 409, r.raw);
  assert.equal(r.body.code, 'PAYMENT_IN_FLIGHT');
  assert.match(r.body.error, /\$400\.00 payment for this event has been processing since/);
  assert.equal(createCalls.length, 0);
});

test('a processing payment for ANOTHER invoice on the same proposal still blocks (D3)', async () => {
  const p = await seedProposal();
  const target = await seedInvoice(p);
  const other = await seedInvoice(p);
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at, invoice_id)
     VALUES ($1, $2, 40000, 'processing', NOW(), $3)`,
    [p, `pi_${NONCE}_otherinv`, other.id]
  );
  const r = await post(`/api/stripe/create-intent-for-invoice/${target.token}`);
  assert.equal(r.status, 409, r.raw);
  assert.equal(r.body.code, 'PAYMENT_IN_FLIGHT');
});

test('a pending row that Stripe reports processing refuses (backstop), succeeded too, requires_payment_method mints', async () => {
  for (const status of ['processing', 'succeeded']) {
    const p = await seedProposal();
    const inv = await seedInvoice(p);
    const id = `pi_${NONCE}_${status}`;
    await pool.query(
      `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status) VALUES ($1, $2, 40000, 'pending')`, [p, id]
    );
    scripted.set(id, { id, status, amount: 40000, created: Math.floor(Date.now() / 1000) });
    const r = await post(`/api/stripe/create-intent-for-invoice/${inv.token}`);
    assert.equal(r.status, 409, `${status}: ${r.raw}`);
    assert.equal(r.body.code, 'PAYMENT_IN_FLIGHT');
    assert.equal(createCalls.length, 0);
  }
  const p = await seedProposal();
  const inv = await seedInvoice(p);
  const id = `pi_${NONCE}_rpm`;
  await pool.query(`INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status) VALUES ($1, $2, 40000, 'pending')`, [p, id]);
  scripted.set(id, { id, status: 'requires_payment_method', amount: 40000 });
  const r = await post(`/api/stripe/create-intent-for-invoice/${inv.token}`);
  assert.equal(r.status, 200, r.raw);
  assert.equal(createCalls.length, 1);
});

test('a Stripe outage on the backstop read is a 503, never a fresh intent (D7)', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p);
  await pool.query(`INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status) VALUES ($1, $2, 40000, 'pending')`, [p, `pi_${NONCE}_outage`]);
  retrieveFailure = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const r = await post(`/api/stripe/create-intent-for-invoice/${inv.token}`);
  assert.equal(r.status, 503, r.raw);
  assert.equal(createCalls.length, 0);
});

test('with nothing in flight the rail mints and the session row carries invoice_id', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p);
  const r = await post(`/api/stripe/create-intent-for-invoice/${inv.token}`);
  assert.equal(r.status, 200, r.raw);
  assert.ok(r.body.clientSecret);
  assert.equal(createCalls[0].metadata.invoice_id, String(inv.id));
  const sess = (await pool.query('SELECT invoice_id, status FROM stripe_sessions WHERE proposal_id = $1', [p])).rows[0];
  assert.equal(Number(sess.invoice_id), inv.id);
  assert.equal(sess.status, 'pending');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/routes/stripe.invoiceIntentInFlight.test.js`
Expected: the first four tests FAIL (200 instead of 409/503); the last fails on `invoice_id` being null.

- [ ] **Step 3: Edit the rail**

In `server/routes/stripe.js`, near the other utils requires at the top, add:

```js
const { assertNoInFlightPayment, assertNoIntentSettlingAtStripe } = require('../utils/paymentInFlight');
```

In the `create-intent-for-invoice` SELECT, add `p.event_timezone,` after `p.stripe_customer_id,`.

After the extension gate block (the `if (extGate.rows[0]) { ... }` closes) and before `const balanceCents = inv.amount_due - inv.amount_paid;`, insert:

```js
  // Bank debit in flight (spec 2026-09-14 section 5.1): a payment already
  // settling on this proposal refuses a second intent. Any in-flight payment
  // blocks, not only one for this invoice (D3): a second payment on an event
  // that already has money settling is far more likely a duplicate than a
  // legitimate second bill. Proposal 784 paid its Balance twice this way.
  await assertNoInFlightPayment({ proposalId: inv.proposal_id, timeZone: inv.event_timezone });
```

After the `if (balanceCents <= 0) { throw ... ALREADY_PAID }` block and before `const customerId = await getOrCreateCustomer(...)`, insert:

```js
  // The backstop that does not depend on the processing webhook: the newest
  // recent pending intents, read from Stripe. Fails closed on an outage (D7).
  await assertNoIntentSettlingAtStripe({ proposalId: inv.proposal_id, stripe, timeZone: inv.event_timezone });
```

Change the session insert to carry the invoice:

```js
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, invoice_id)
     VALUES ($1, $2, $3, 'pending', $4)
     ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
    [inv.proposal_id, paymentIntent.id, balanceCents, inv.invoice_id]
  );
```

- [ ] **Step 4: Run the suites**

Run: `node --test server/routes/stripe.invoiceIntentInFlight.test.js`
Expected: PASS, 5 tests.

Run: `node --test server/routes/stripe.invoiceIntentArchived.test.js`
Expected: PASS, unchanged. (Its fake Stripe has no `retrieve`; the archived guard throws before the backstop, and the happy-path test seeds no pending row, so the backstop reads nothing. If a test there now hits `retrieve`, add `retrieve: async (id) => { const e = new Error('none'); e.code = 'resource_missing'; throw e; }` to that file's fake.)

- [ ] **Step 5: Commit**

```bash
git add server/routes/stripe.js server/routes/stripe.invoiceIntentInFlight.test.js
git commit -F - <<'MSG'
feat(stripe): invoice rail refuses a second intent while one is in flight

Bank debit in flight, spec 2026-09-14 section 5.1.
MSG
```

---

### Task S7: The deposit rail refuses too

**Files:**
- Modify: `server/routes/stripeCreateIntent.js` (require near line 16; SELECT near line 39; guard after `const amount = ...` near line 120; comment at lines 157 to 162)
- Test: `server/routes/stripeCreateIntent.test.js` (append two tests)

**Interfaces:**
- Consumes: `assertNoInFlightPayment`, `assertNoIntentSettlingAtStripe` (Task S3).

- [ ] **Step 1: Write the failing tests**

Append to `server/routes/stripeCreateIntent.test.js` (the file has `seedProposal()` returning `{ id, token }`, `post(path, body)`, a `retrieveResult` scripted per test, and `createCalls`):

```js
test('PAYMENT_IN_FLIGHT: a processing row on the proposal refuses before any Stripe call', async () => {
  const p = await seedProposal();
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at)
     VALUES ($1, $2, 10000, 'processing', NOW() - INTERVAL '1 day')`,
    [p.id, `pi_${NONCE}_inflight_row`]
  );
  const before = createCalls.length;
  const res = await post(`/api/stripe/create-intent/${p.token}`, { payment_option: 'deposit' });
  assert.equal(res.status, 409, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.code, 'PAYMENT_IN_FLIGHT');
  assert.match(body.error, /\$100\.00 payment for this event has been processing since/);
  assert.equal(createCalls.length, before, 'nothing minted');
});

test('PAYMENT_IN_FLIGHT: the newest pending intent that Stripe reports processing refuses instead of minting beside it', async () => {
  const p = await seedProposal();
  const piId = `pi_${NONCE}_stripe_processing`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status) VALUES ($1, $2, 10000, 'pending')`,
    [p.id, piId]
  );
  retrieveResult = { id: piId, status: 'processing', amount: 10000, created: Math.floor(Date.now() / 1000), metadata: {} };
  const before = createCalls.length;
  const res = await post(`/api/stripe/create-intent/${p.token}`, { payment_option: 'deposit' });
  assert.equal(res.status, 409, res.body);
  assert.equal(JSON.parse(res.body).code, 'PAYMENT_IN_FLIGHT');
  assert.equal(createCalls.length, before, 'the fix-list defect: no fresh intent beside a settling one');
  assert.ok(!cancelCalls.includes(piId), 'a settling intent is never cancelled');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/routes/stripeCreateIntent.test.js`
Expected: both new tests FAIL with status 200; the rest pass.

- [ ] **Step 3: Edit the rail**

Add the require after the `stripeRouteHelpers` line:

```js
const { assertNoInFlightPayment, assertNoIntentSettlingAtStripe } = require('../utils/paymentInFlight');
```

In the proposal SELECT add `p.event_timezone,` after `p.pricing_snapshot,`.

Directly after the `const amount = isFullPay ? ... : DEPOSIT_AMOUNT;` statement and before the `// Intent identity = (amount, election metadata)` comment, insert:

```js
  // Bank debit in flight (spec 2026-09-14 section 5.1). Runs BEFORE the reuse
  // and stale-cancel logic below, so a settling intent is never reused, never
  // cancelled, and never minted beside. The Stripe read is the backstop that
  // does not depend on the processing webhook and fails closed on an outage.
  await assertNoInFlightPayment({ proposalId: proposal.id, timeZone: proposal.event_timezone });
  await assertNoIntentSettlingAtStripe({ proposalId: proposal.id, stripe, timeZone: proposal.event_timezone });
```

Replace the comment above the stale-cancel condition (the lines beginning `// Stale-intent safety: cancel when the identity ...` through `// ... records what was charged.`) with:

```js
      // Stale-intent safety: cancel when the identity (amount OR election)
      // no longer matches, so a stale tab can't confirm an old total/election.
      // A succeeded/processing intent never reaches here any more (the
      // in-flight guards above refuse the request), so the status filter is
      // belt and braces for the one retrieve this branch makes itself.
```

Leave the condition itself unchanged.

- [ ] **Step 4: Run the suite**

Run: `node --test server/routes/stripeCreateIntent.test.js`
Expected: PASS, previous count plus two.

- [ ] **Step 5: Commit**

```bash
git add server/routes/stripeCreateIntent.js server/routes/stripeCreateIntent.test.js
git commit -F - <<'MSG'
feat(stripe): deposit rail refuses a second intent while one is in flight

Bank debit in flight, spec 2026-09-14 section 5.1. Retires the 2026-08-28
create-intent double-mint entry.
MSG
```

---

### Task S8: Widen the autopay and option-switch scans

**Files:**
- Modify: `server/utils/autopayDurableCharge.js:80` (the `status = 'pending'` predicate) and its SELECTION comment
- Modify: `server/routes/proposals/publicSwitch.js` (both `status IN ('pending', 'failed')` scans, near lines 229 and 520)
- Test: `server/utils/autopayDurableCharge.test.js` (append one), `server/routes/proposals/publicSwitch.test.js` (append one)

- [ ] **Step 1: Write the failing tests**

Append to `server/utils/autopayDurableCharge.test.js` (uses `propId`, `clearSessions()`, `fakeStripe(byId)`):

```js
test('priorBalanceChargeSettling > a row the processing webhook flipped to processing is still scanned and blocks', async () => {
  await clearSessions();
  const priorId = `pi_${MARK}_procrow`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at)
     VALUES ($1, $2, 40000, 'processing', NOW() - INTERVAL '1 day')`, [propId, priorId]
  );
  const stripe = fakeStripe({ [priorId]: { id: priorId, status: 'processing', metadata: { payment_type: 'balance' } } });
  const r = await priorBalanceChargeSettling({ proposalId: propId, stripe });
  assert.equal(r.skip, true, 'a settling bank debit must block the saved-card charge');
  assert.equal(r.reason, 'settling');
});
```

Append to `server/routes/proposals/publicSwitch.test.js` (uses `insertProposal()`, `scriptedIntents`, `quoteFor`, `optionTotal`, `request`, `rowOf`, `hostedPkgId`, `byobPkgId`, `cancelCalls`):

```js
test('PAYMENT_IN_FLIGHT: a row already flipped to processing by the webhook blocks the switch', async () => {
  const p = await insertProposal();
  const piId = `pi_procrow_${crypto.randomBytes(4).toString('hex')}`;
  scriptedIntents.set(piId, { id: piId, status: 'processing' });
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at)
     VALUES ($1, $2, 35000, 'processing', NOW())`, [p.id, piId]);
  const quote = await quoteFor(p.token);
  const res = await request('POST', `/api/proposals/t/${p.token}/switch`, {
    body: { package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [], acknowledged_total: optionTotal(quote, hostedPkgId) },
  });
  assert.equal(res.status, 409, res.raw);
  assert.equal(res.body.code, 'PAYMENT_IN_FLIGHT');
  const row = await rowOf(p.id);
  assert.equal(row.package_id, byobPkgId, 'row untouched while money is in flight');
  assert.ok(!cancelCalls.includes(piId), 'a settling intent is never canceled');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test server/utils/autopayDurableCharge.test.js` and `node --test server/routes/proposals/publicSwitch.test.js`
Expected: the new autopay test FAILS with `skip: false`; the new switch test FAILS with 200.

- [ ] **Step 3: Widen the scans**

`server/utils/autopayDurableCharge.js`: change `AND status = 'pending'` to `AND status IN ('pending', 'processing')` and add to the SELECTION comment, after the `status = 'pending'` bullet:

```
 *   - 'processing' is included since 2026-09-14 (bank debit in flight): the
 *     payment_intent.processing webhook flips a settling row to 'processing',
 *     and a pending-only scan would drop exactly the intent this guard exists
 *     to see. Stripe still decides: a processing row Stripe now reports terminal
 *     does not block.
```

`server/routes/proposals/publicSwitch.js`: at both scans change `status IN ('pending', 'failed')` to `status IN ('pending', 'failed', 'processing')`, and add one line to the comment above the first: `// 'processing' (bank debit in flight, 2026-09-14) is in flight by definition.`

- [ ] **Step 4: Run both suites**

Expected: PASS, each previous count plus one.

- [ ] **Step 5: Commit**

```bash
git add server/utils/autopayDurableCharge.js server/utils/autopayDurableCharge.test.js server/routes/proposals/publicSwitch.js server/routes/proposals/publicSwitch.test.js
git commit -F - <<'MSG'
fix(payments): autopay and switch scans see processing rows

Bank debit in flight, spec 2026-09-14 section 5.2.
MSG
```

---

### Task S9: Balance reminders defer while a payment is in flight

**Files:**
- Modify: `server/utils/balanceReminderHandlers.js` (imports; `sendBalanceReminder`; `sendBalanceLate`)
- Modify: `server/utils/balanceSmsHandlers.js` (imports; `loadBalanceSmsContext`)
- Create: `server/utils/balanceReminderHandlers.test.js`
- Test: `server/utils/balanceSmsHandlers.test.js` (append one)

**Interfaces:**
- Consumes: `findInFlightPayments` (S3), `DeferMessageError` (S2).

- [ ] **Step 1: Write the failing tests**

Append to `server/utils/balanceSmsHandlers.test.js` (uses `proposalId`, `clientId`, `dispatchPending`, `registerBalanceSmsHandlers`, `_clearHandlersForTest`):

```js
test('balance_late_t1_sms handler > defers a day while a bank debit is processing, never sends', async () => {
  _clearHandlersForTest();
  registerBalanceSmsHandlers();
  const { __setSmsDeps } = require('./sms');
  let sent = 0;
  __setSmsDeps({ sendSMS: async () => { sent += 1; return { sid: `stub-${Date.now()}` }; } });
  try {
    await pool.query(
      `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at)
       VALUES ($1, $2, 90000, 'processing', NOW() - INTERVAL '2 days')`,
      [proposalId, `pi_balsms_${Date.now()}`]
    );
    await pool.query(
      `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
       VALUES ($1, 'proposal', 'balance_late_t1_sms', 'client', $2, 'sms', NOW() - INTERVAL '1 minute')`,
      [proposalId, clientId]
    );
    await dispatchPending();
    const { rows } = await pool.query(
      "SELECT status, error_message, scheduled_for > NOW() + INTERVAL '23 hours' AS pushed FROM scheduled_messages WHERE entity_id=$1 AND message_type='balance_late_t1_sms'",
      [proposalId]
    );
    assert.strictEqual(rows[0].status, 'deferred');
    assert.strictEqual(rows[0].error_message, 'deferred: payment_in_flight');
    assert.strictEqual(rows[0].pushed, true);
    assert.strictEqual(sent, 0);
  } finally {
    __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [proposalId]);
  }
});
```

Create `server/utils/balanceReminderHandlers.test.js`:

```js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { registerBalanceReminderHandlers } = require('./balanceReminderHandlers');
const { registerHandler, getHandlerMeta, _clearHandlersForTest, dispatchPending } = require('./scheduledMessageDispatcher');

if (process.env.NODE_ENV === 'production') {
  throw new Error('balanceReminderHandlers.test.js refuses to run against production');
}

let clientId;
let proposalId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, email_status) VALUES ('Balance Email Test', $1, 'ok') RETURNING id",
    [`balemail-${Date.now()}@example.com`]
  );
  clientId = c.rows[0].id;
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, amount_paid, balance_due_date, autopay_enrolled, token)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'deposit_paid', 'birthday-party', 1000, 100, CURRENT_DATE + INTERVAL '14 days', false, gen_random_uuid())
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  _clearHandlersForTest();
  registerBalanceReminderHandlers(registerHandler);
});

afterEach(async () => {
  await pool.query('DELETE FROM scheduled_messages WHERE entity_type=$1 AND entity_id=$2', ['proposal', proposalId]);
  await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

async function queue(messageType) {
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', $2, 'client', $3, 'email', NOW() - INTERVAL '1 minute')`,
    [proposalId, messageType, clientId]
  );
}
async function rowStatus(messageType) {
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE entity_id=$1 AND message_type=$2", [proposalId, messageType]
  );
  return rows[0];
}

test('registers the five balance email types', () => {
  for (const t of ['balance_reminder_autopay_t3', 'balance_reminder_non_autopay_t3', 'balance_due_today', 'balance_late_t1', 'balance_late_t3']) {
    assert.ok(getHandlerMeta(t), t);
  }
});

test('balance_late_t1 sends (logged only under the test flag) when nothing is in flight', async () => {
  await queue('balance_late_t1');
  await dispatchPending();
  assert.equal((await rowStatus('balance_late_t1')).status, 'sent');
});

test('every balance email defers a day while a bank debit is processing', async () => {
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at)
     VALUES ($1, $2, 90000, 'processing', NOW() - INTERVAL '3 days')`,
    [proposalId, `pi_balemail_${Date.now()}`]
  );
  for (const t of ['balance_reminder_non_autopay_t3', 'balance_due_today', 'balance_late_t1', 'balance_late_t3']) {
    await queue(t);
  }
  await dispatchPending();
  for (const t of ['balance_reminder_non_autopay_t3', 'balance_due_today', 'balance_late_t1', 'balance_late_t3']) {
    const r = await rowStatus(t);
    assert.equal(r.status, 'deferred', t);
    assert.equal(r.error_message, 'deferred: payment_in_flight', t);
  }
});

test('a processing row older than 14 days no longer defers', async () => {
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at)
     VALUES ($1, $2, 90000, 'processing', NOW() - INTERVAL '15 days')`,
    [proposalId, `pi_balemail_old_${Date.now()}`]
  );
  await queue('balance_late_t3');
  await dispatchPending();
  assert.equal((await rowStatus('balance_late_t3')).status, 'sent');
});

test('a zero balance still suppresses, and suppression wins over an in-flight row', async () => {
  await pool.query('UPDATE proposals SET amount_paid = total_price WHERE id = $1', [proposalId]);
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at)
     VALUES ($1, $2, 90000, 'processing', NOW())`,
    [proposalId, `pi_balemail_paid_${Date.now()}`]
  );
  await queue('balance_due_today');
  await dispatchPending();
  const r = await rowStatus('balance_due_today');
  assert.equal(r.status, 'suppressed');
  assert.match(r.error_message, /balance_not_positive/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test server/utils/balanceReminderHandlers.test.js` and `node --test server/utils/balanceSmsHandlers.test.js`
Expected: the defer tests FAIL with status `sent`; the others pass. If the dispatcher's entity lookup rejects the proposal for a missing column, read the error and add that column to the `INSERT INTO proposals` above (the SMS test's insert is the reference shape).

- [ ] **Step 3: Edit the handlers**

`server/utils/balanceReminderHandlers.js`: change the errors import to `const { SuppressMessageError, DeferMessageError } = require('./errors');` and add `const { findInFlightPayments } = require('./paymentInFlight');`. In BOTH `sendBalanceReminder` and `sendBalanceLate`, directly after the `if (balanceDue <= 0) { throw new SuppressMessageError(...) }` block, insert:

```js
  // Bank debit in flight (spec 2026-09-14 section 6): the balance is still
  // owed on the row, but the money is on its way. Defer, never suppress, so a
  // bounced debit resumes the ladder instead of silencing it.
  if ((await findInFlightPayments(entity.id)).length) {
    throw new DeferMessageError('payment_in_flight');
  }
```

`server/utils/balanceSmsHandlers.js`: change the errors import to `const { SuppressMessageError, DeferMessageError } = require('./errors');`, add `const { findInFlightPayments } = require('./paymentInFlight');`, and in `loadBalanceSmsContext` directly after the `if (!(balanceDue > 0)) throw new SuppressMessageError(...)` line insert:

```js
  // Bank debit in flight (spec 2026-09-14 section 6): defer, never suppress.
  if ((await findInFlightPayments(ctx.id)).length) throw new DeferMessageError('payment_in_flight');
```

Update the `loadBalanceSmsContext` doc comment's second sentence to read: `An already-cleared balance (client paid before the reminder fired) and the contact-deliverability skips throw SuppressMessageError; a balance with a bank debit still processing throws DeferMessageError so the row waits a day instead.`

- [ ] **Step 4: Run the suites**

Run: `node --test server/utils/balanceReminderHandlers.test.js` (expect PASS, 5), `node --test server/utils/balanceSmsHandlers.test.js` (expect PASS, previous plus one), `node --test server/utils/balanceReminderScheduling.test.js` and `node --test server/utils/balanceReminderScheduling.archivedGuard.test.js` (expect PASS, unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/utils/balanceReminderHandlers.js server/utils/balanceReminderHandlers.test.js server/utils/balanceSmsHandlers.js server/utils/balanceSmsHandlers.test.js
git commit -F - <<'MSG'
feat(reminders): balance ladder defers while a bank debit is processing

Bank debit in flight, spec 2026-09-14 section 6.
MSG
```

---

### Task S10: The payloads

**Files:**
- Modify: `server/routes/invoices.js` (public GET near lines 52 to 175; admin GET at lines 208 to 226)
- Modify: `server/routes/proposals/publicToken.js` (`buildPublicProposalPayload` parallel fetch near line 176; return object near line 250; `payment-state` at lines 65 to 79)
- Create: `server/routes/invoices.pendingPayment.test.js`
- Test: `server/routes/proposals/publicToken.paymentState.test.js` (append two)

**Interfaces:**
- Produces (the seam the client lane consumes, spec section 7):
  - `GET /api/invoices/t/:token` → `invoice.pending_payment: null | { amount_cents, started_at, invoice_id, invoice_number }` and `invoice.pending_payment_for_this_invoice: boolean`. INSIDE `invoice`: the page stores `data.invoice` and nothing else.
  - `GET /api/proposals/t/:token` → top-level `pending_payment` (same shape or null).
  - `GET /api/proposals/t/:token/payment-state` → `pending_payment` (same shape or null).
  - `GET /api/invoices/proposal/:proposalId` → `pending_payments: Array<{ amount_cents, started_at, invoice_id, invoice_number }>`.

- [ ] **Step 1: Write the failing tests**

```js
// server/routes/invoices.pendingPayment.test.js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const invoicesRouter = require('./invoices');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoices.pendingPayment.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminToken, adminUserId;
const proposalIds = [];
const clientIds = [];

function request(method, path, { token } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method, headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch {} resolve({ status: res.statusCode, body: j, raw: d }); }); }
    );
    req.on('error', reject);
    req.end();
  });
}

async function seedProposal() {
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ('Pending Payload', $1) RETURNING id`, [`pp-${NONCE}-${clientIds.length}@example.com`]);
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, event_type, pricing_snapshot, event_timezone)
     VALUES ($1, 'deposit_paid', 500, 100, 'wedding', '{}'::jsonb, 'America/Chicago') RETURNING id`,
    [c.rows[0].id]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}
async function seedInvoice(proposalId, label = 'Balance') {
  const token = crypto.randomUUID();
  const r = await pool.query(
    `INSERT INTO invoices (proposal_id, token, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, $3, $4, 40000, 0, 'sent') RETURNING id, invoice_number`,
    [proposalId, token, `INV-${NONCE}-${label}-${proposalId}`, label]
  );
  return { token, id: r.rows[0].id, number: r.rows[0].invoice_number };
}
async function seedProcessing(proposalId, invoiceId, ago = '1 day') {
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at, invoice_id)
     VALUES ($1, $2, 40000, 'processing', NOW() - $3::interval, $4)`,
    [proposalId, `pi_${NONCE}_${crypto.randomBytes(3).toString('hex')}`, ago, invoiceId]
  );
}

before(async () => {
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version) VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id`,
    [`pp-admin-${NONCE}@example.com`, await bcrypt.hash('x', 4)]
  );
  adminUserId = admin.rows[0].id;
  adminToken = jwt.sign({ userId: adminUserId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  if (adminUserId) await pool.query('DELETE FROM users WHERE id = $1', [adminUserId]);
  await pool.end();
});

test('public invoice GET > pending_payment null and for_this_invoice false when nothing is in flight', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p);
  const r = await request('GET', `/api/invoices/t/${inv.token}`);
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.invoice.pending_payment, null);
  assert.equal(r.body.invoice.pending_payment_for_this_invoice, false);
});

test('public invoice GET > carries the newest in-flight payment, inside invoice, with the intent id stripped', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p);
  await seedProcessing(p, inv.id);
  const r = await request('GET', `/api/invoices/t/${inv.token}`);
  assert.equal(r.status, 200, r.raw);
  const pp = r.body.invoice.pending_payment;
  assert.equal(pp.amount_cents, 40000);
  assert.ok(pp.started_at);
  assert.equal(pp.invoice_id, inv.id);
  assert.equal(pp.invoice_number, inv.number);
  assert.equal('stripe_payment_intent_id' in pp, false);
  assert.equal(r.body.invoice.pending_payment_for_this_invoice, true);
  assert.equal('pending_payment' in r.body, false, 'never a top-level sibling the page would not read');
});

test('public invoice GET > an in-flight payment for another invoice on the proposal is reported, for_this_invoice false', async () => {
  const p = await seedProposal();
  const target = await seedInvoice(p, 'Balance');
  const other = await seedInvoice(p, 'Additional Services');
  await seedProcessing(p, other.id);
  const r = await request('GET', `/api/invoices/t/${target.token}`);
  assert.equal(r.body.invoice.pending_payment.invoice_id, other.id);
  assert.equal(r.body.invoice.pending_payment_for_this_invoice, false);
});

test('admin invoices-by-proposal > pending_payments lists every in-flight payment, intent id stripped', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p);
  await seedProcessing(p, inv.id, '2 days');
  await seedProcessing(p, null, '1 hour');
  const r = await request('GET', `/api/invoices/proposal/${p}`, { token: adminToken });
  assert.equal(r.status, 200, r.raw);
  assert.ok(Array.isArray(r.body.invoices));
  assert.equal(r.body.pending_payments.length, 2);
  assert.equal(r.body.pending_payments[0].invoice_id, null, 'newest first');
  assert.equal(r.body.pending_payments[1].invoice_number, inv.number);
  assert.ok(r.body.pending_payments.every((x) => !('stripe_payment_intent_id' in x)));
});
```

Append to `server/routes/proposals/publicToken.paymentState.test.js` (uses `insertProposal()` returning `{ id, token }`, `get(path)`, and the `createdProposalIds` cleanup set; add a `stripe_sessions` delete to its `after` block if it lacks one: `await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1::int[])', [[...createdProposalIds]]);` before the proposals delete):

```js
test('payment-state and the full GET carry pending_payment when a bank debit is processing', async () => {
  const p = await insertProposal({ status: 'accepted', amountPaid: 0 });
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at)
     VALUES ($1, $2, 10000, 'processing', NOW() - INTERVAL '1 hour')`,
    [p.id, `pi_pstate_${Date.now()}`]
  );
  const state = await get(`/api/proposals/t/${p.token}/payment-state`);
  assert.equal(state.status, 200);
  assert.equal(state.body.status, 'accepted');
  assert.equal(state.body.pending_payment.amount_cents, 10000);
  assert.ok(state.body.pending_payment.started_at);
  assert.equal('stripe_payment_intent_id' in state.body.pending_payment, false);
  const full = await get(`/api/proposals/t/${p.token}`);
  assert.equal(full.status, 200);
  assert.equal(full.body.pending_payment.amount_cents, 10000);
});

test('payment-state carries pending_payment: null when nothing is in flight', async () => {
  const p = await insertProposal();
  const state = await get(`/api/proposals/t/${p.token}/payment-state`);
  assert.equal(state.status, 200);
  assert.equal(state.body.pending_payment, null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test server/routes/invoices.pendingPayment.test.js` and `node --test server/routes/proposals/publicToken.paymentState.test.js`
Expected: FAIL on the missing fields.

- [ ] **Step 3: Edit `server/routes/invoices.js`**

Add near the other requires: `const { findInFlightPayments, toPublicPending } = require('../utils/paymentInFlight');`

In the public GET, add a fifth query to the `Promise.all` destructuring: change `const [lineItemsRes, paymentsRes, refundsRes, extRes] = await Promise.all([` to `const [lineItemsRes, paymentsRes, refundsRes, extRes, inFlight] = await Promise.all([` and append as the last element of the array, after the service-extension query:

```js
    // Bank debit in flight (spec 2026-09-14 section 7): the newest processing
    // payment on this invoice's proposal. Any in-flight payment on the
    // proposal is reported (D3); for_this_invoice says whether it is this one.
    findInFlightPayments(invoice.proposal_id),
```

In the response, inside the `invoice: { ... }` object after `extension,` add:

```js
      pending_payment: toPublicPending(inFlight),
      pending_payment_for_this_invoice: !!(inFlight[0] && inFlight[0].invoice_id === invoice.id),
```

In the admin GET `/proposal/:proposalId`, replace the query and response with:

```js
  const [result, inFlight] = await Promise.all([
    pool.query(
      `SELECT
         id, token, proposal_id, invoice_number, label,
         amount_due, amount_paid, status, due_date,
         locked, locked_at, created_at, updated_at
       FROM invoices
       WHERE proposal_id = $1
       ORDER BY created_at ASC`,
      [proposalId]
    ),
    findInFlightPayments(proposalId),
  ]);

  // pending_payments: bank debits still processing on this proposal (spec
  // 2026-09-14 section 10), newest first, intent id stripped.
  res.json({
    invoices: result.rows,
    pending_payments: inFlight.map(({ amount_cents, started_at, invoice_id, invoice_number }) => ({ amount_cents, started_at, invoice_id, invoice_number })),
  });
```

- [ ] **Step 4: Edit `server/routes/proposals/publicToken.js`**

Add near the other requires: `const { findInFlightPayments, toPublicPending } = require('../../utils/paymentInFlight');`

In `buildPublicProposalPayload`, change the parallel fetch to three queries:

```js
  const [addonsRes, dpRes, inFlight] = await Promise.all([
    db.query(
      'SELECT id, proposal_id, addon_id, addon_name, billing_type, rate, quantity::float8 AS quantity, line_total, variant FROM proposal_addons WHERE proposal_id = $1 ORDER BY id',
      [proposal.id]
    ),
    db.query(
      'SELECT token AS drink_plan_token FROM drink_plans WHERE proposal_id = $1 LIMIT 1',
      [proposal.id]
    ),
    // Bank debit in flight (spec 2026-09-14 section 7).
    findInFlightPayments(proposal.id, db),
  ]);
```

In the returned object, after `drink_plan_token: drinkPlanToken,` add `pending_payment: toPublicPending(inFlight),`.

In the `payment-state` route, after the proposal SELECT (which returns `row` with `id` added to the select list: change `SELECT status, amount_paid, total_price, payment_type` to `SELECT id, status, amount_paid, total_price, payment_type`), add before `res.json`:

```js
  // Bank debit in flight (spec 2026-09-14 section 8.3): the settle poll ends
  // the moment the row shows a processing payment. Still non-mutating.
  const inFlight = await findInFlightPayments(row.id);
```

and add `pending_payment: toPublicPending(inFlight),` to the `res.json` object.

- [ ] **Step 5: Run the suites**

Run: `node --test server/routes/invoices.pendingPayment.test.js` (PASS, 4), `node --test server/routes/proposals/publicToken.paymentState.test.js` (PASS, previous plus two), then `node --test server/routes/proposals/publicToken.test.js`, `node --test server/routes/proposals/publicToken.archived.test.js`, `node --test server/routes/invoices.refunds.test.js`, `node --test server/routes/invoices.extension.test.js`, `node --test server/routes/invoices.clientTokenValidation.test.js` (PASS, unchanged).

- [ ] **Step 6: Commit**

```bash
git add server/routes/invoices.js server/routes/invoices.pendingPayment.test.js server/routes/proposals/publicToken.js server/routes/proposals/publicToken.paymentState.test.js
git commit -F - <<'MSG'
feat(payloads): pending_payment on invoice, proposal, payment-state, admin invoices

Bank debit in flight, spec 2026-09-14 section 7.
MSG
```

---

### Task S11: Docs, fix list, walkthroughs owed

**Files:**
- Modify: `README.md` (folder tree: `server/routes/stripeWebhookHandlers/` block near line 288; `server/utils` block near line 344)
- Modify: `docs/fix-list-remaining-2026-07-02.md:784-800` (the two 2026-08-28 entries)
- Modify: `docs/walkthroughs-owed.md` (one new entry)

- [ ] **Step 1: README tree**

Under the `stripeWebhookHandlers/` line, after the `paymentIntentSucceeded.js` line, add:

```
│   │   │   ├── paymentIntentProcessing.js # bank debit in flight: records `processing` on stripe_sessions, one activity row, client email (spec 2026-09-14)
```

In the `server/utils` block, next to `autopayDurableCharge.js`, add two lines in alphabetical position:

```
│   │   ├── bankPaymentProcessingNotify.js # "we received your bank payment" client email, post-commit, email only (spec 2026-09-14)
│   │   ├── paymentInFlight.js  # THE in-flight payment definition (processing < 14d) + the rails' Stripe backstop; every consumer reads through it
```

- [ ] **Step 2: Fix list**

Delete the two bullets that begin `- **An async payment method (bank debit, Cash App, Klarna) traps the settle page for days.**` and `- **create-intent mints a fresh intent beside a `succeeded`/`processing` one, so a second card entry is a second real charge.**` (through `of the settle lane.`). In their place add one line:

```
- CLOSED 2026-09-14 (lanes ach-server + ach-client, spec 2026-09-14-bank-debit-in-flight): the settle-page trap on async methods and the create-intent double-mint beside a settling intent. Proposal 784 paid its Balance twice by bank debit before this landed.
```

- [ ] **Step 3: Walkthroughs owed**

Add under the Status block, as its own entry (match the surrounding heading style):

```
- **First real bank debit after the 2026-09-14 deploy (bank debit in flight).** Cannot be rehearsed: dev talks to live Stripe and a debit is real money. On the first client who pays by bank: confirm the `stripe_sessions` row went `processing` with `processing_at` and (for a Balance) `invoice_id`; the `payment_processing` activity entry is on the proposal; the client's invoice or proposal page shows "Your bank payment is processing."; the admin payment panel shows the Processing line; any balance reminder row for that proposal went `deferred`; and the "We received your bank payment" email left (Resend log). Then on settlement: the row went `succeeded`, the reminders were reactivated or suppressed as paid, and the receipt went out.
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/fix-list-remaining-2026-07-02.md docs/walkthroughs-owed.md
git commit -F - <<'MSG'
docs: bank debit in flight, tree, fix list closure, owed walk

Spec 2026-09-14 sections 12 and 13.
MSG
```

---

### Task S12: Reader audit and the full reached-suite run

**Files:** none modified unless the audit finds a reader the spec missed.

- [ ] **Step 1: Grep every reader of `stripe_sessions`**

Run: `grep -rn "stripe_sessions" server --include=*.js | grep -v "\.test\.js" | grep -v "^server/scripts"`

Record each hit as one of: widened (autopayDurableCharge.js, publicSwitch.js x2), new writer (paymentIntentProcessing.js), new reader (paymentInFlight.js, invoices.js, publicToken.js), or unchanged with the reason from spec section 5.3 (stripeCreateIntent.js reuse lookup, invoiceVoid.js, publicToken.js sign-email suppression, stripe.js payment-link lookups, paymentIntentSucceeded.js and paymentIntentFailed.js releases, checkoutSessionCompleted.js link session). A hit that fits none of these is a finding: stop and report it before merge.

- [ ] **Step 2: Run every reached suite, one at a time, and record the pass counts**

```
node --test server/db/constraintContract.test.js
node --test server/utils/paymentInFlight.test.js
node --test server/utils/bankPaymentProcessingNotify.test.js
node --test server/utils/scheduledMessageDispatcher.test.js
node --test server/utils/scheduledMessageDispatcher.claim.test.js
node --test server/utils/balanceReminderHandlers.test.js
node --test server/utils/balanceSmsHandlers.test.js
node --test server/utils/balanceReminderScheduling.test.js
node --test server/utils/autopayDurableCharge.test.js
node --test server/routes/stripeWebhook.processing.test.js
node --test server/routes/stripeWebhook.guards.test.js
node --test server/routes/stripe.webhook.test.js
node --test server/routes/stripeWebhook.invoiceLink.test.js
node --test server/routes/stripeWebhook.balanceBranch.test.js
node --test server/routes/stripeWebhook.gratuityApply.test.js
node --test server/routes/stripe.invoiceIntentInFlight.test.js
node --test server/routes/stripe.invoiceIntentArchived.test.js
node --test server/routes/stripeCreateIntent.test.js
node --test server/routes/stripe.chargeBalanceDurable.test.js
node --test server/routes/proposals/publicSwitch.test.js
node --test server/routes/proposals/publicToken.test.js
node --test server/routes/proposals/publicToken.paymentState.test.js
node --test server/routes/proposals/publicToken.archived.test.js
node --test server/routes/invoices.pendingPayment.test.js
node --test server/routes/invoices.refunds.test.js
node --test server/routes/invoices.extension.test.js
```

Expected: every suite PASS with a non-zero count. A suite reporting 0 tests did not run (the dotenv line is the usual cause).

- [ ] **Step 3: File size and lane status**

Run: `npm run check:filesize` and confirm no file the lane touched crossed 1000. Run `git log --oneline main..HEAD` and confirm eleven commits.

---

# Lane `ach-client`

### Task C1: `PendingPaymentCard`

**Files:**
- Create: `client/src/components/PendingPaymentCard.js`
- Test: `client/src/components/PendingPaymentCard.test.js`

**Interfaces:**
- Produces: `<PendingPaymentCard amountCents={number} startedAt={string|Date|null} />`. Title `Your bank payment is processing.` Body as in spec 8.1.

- [ ] **Step 1: Write the failing test**

```js
// client/src/components/PendingPaymentCard.test.js
import React from 'react';
import { render } from '@testing-library/react';
import PendingPaymentCard from './PendingPaymentCard';

test('renders the title, the amount, the start date and the clearing copy, with no em dash', () => {
  const { container } = render(<PendingPaymentCard amountCents={40000} startedAt="2026-09-05T16:05:35.000Z" />);
  const t = container.textContent;
  expect(t).toMatch(/Your bank payment is processing\./);
  expect(t).toMatch(/We received your \$400\.00 bank payment on September 5\./);
  expect(t).toMatch(/four to six business days to clear/);
  expect(t).toMatch(/nothing more is needed from you/);
  expect(t).not.toMatch(/—/);
  expect(container.querySelector('[role="status"]')).not.toBeNull();
});

test('omits the date clause when there is no start date, and never says paid or successful', () => {
  const { container } = render(<PendingPaymentCard amountCents={10000} startedAt={null} />);
  const t = container.textContent;
  expect(t).toMatch(/We received your \$100\.00 bank payment\. Bank payments/);
  expect(t).not.toMatch(/paid in full|successful/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run from `client/`: `CI=true npx react-scripts test --testPathPattern=PendingPaymentCard --watchAll=false`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the component**

```jsx
// client/src/components/PendingPaymentCard.js
import React from 'react';

// Bank debit in flight (spec 2026-09-14 section 8.1). The one card both the
// invoice page and the proposal page show while a bank payment is processing.
// Every figure comes from the server's pending_payment, or, on the invoice
// page in the seconds before the webhook lands, from Stripe's confirm result.
// It never claims the payment succeeded: a bank debit can still bounce.
// No em dashes in copy.
function formatCents(cents) {
  return (Number(cents || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatStarted(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export default function PendingPaymentCard({ amountCents, startedAt }) {
  const when = formatStarted(startedAt);
  return (
    <div className="proposal-paid-card is-pending" role="status" aria-live="polite">
      <h3 className="proposal-paid-title">Your bank payment is processing.</h3>
      <p className="proposal-paid-sub">
        We received your {formatCents(amountCents)} bank payment{when ? ` on ${when}` : ''}. Bank payments take four to six business days to clear. You will get a receipt by email when it does, and nothing more is needed from you.
      </p>
    </div>
  );
}
```

`timeZone: 'UTC'` keeps the test deterministic across machines; `started_at` is an instant and the day is the same in Chicago for any daytime confirm, which is the case that matters.

- [ ] **Step 4: Run the test**

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/PendingPaymentCard.js client/src/components/PendingPaymentCard.test.js
git commit -F - <<'MSG'
feat(client): PendingPaymentCard for a processing bank debit

Bank debit in flight, spec 2026-09-14 section 8.1.
MSG
```

---

### Task C2: The invoice page stops lying on a bank debit

**Files:**
- Modify: `client/src/pages/invoice/InvoicePage.js` (`PaymentForm`; page state; `handlePayClick`; render)
- Create: `client/src/pages/invoice/InvoicePage.test.js`

**Interfaces:**
- Consumes: `PendingPaymentCard` (C1); server payload `invoice.pending_payment` and `invoice.pending_payment_for_this_invoice` (server Task S10); the api error shape `{ message, code, fieldErrors, status }`.

- [ ] **Step 1: Write the failing tests**

```js
// client/src/pages/invoice/InvoicePage.test.js
import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

jest.mock('react-router-dom', () => ({ useParams: () => ({ token: 'tok-1' }) }));
jest.mock('../../context/ToastContext', () => ({ useToast: () => ({ success: jest.fn(), error: jest.fn() }) }));
jest.mock('@stripe/stripe-js', () => ({ loadStripe: () => Promise.resolve({}) }));

const confirmPayment = jest.fn();
jest.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }) => <div data-testid="elements">{children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmPayment }),
  useElements: () => ({}),
}));

const api = { get: jest.fn(), post: jest.fn() };
jest.mock('../../utils/api', () => ({ __esModule: true, default: api }));

import InvoicePage from './InvoicePage';

const baseInvoice = {
  id: 363, token: 'tok-1', proposal_id: 784, invoice_number: 'INV-0363', label: 'Balance',
  amount_due: 40000, amount_paid: 0, status: 'sent', due_date: '2026-09-05', created_at: '2026-09-03T12:45:52Z',
  event_date: '2026-09-19', event_type: 'Cocktail Party', client_name: 'Thekla Eftychiadou',
  line_items: [], payments: [], refunds: [], extension: null,
  pending_payment: null, pending_payment_for_this_invoice: false,
};
const pending = { amount_cents: 40000, started_at: '2026-09-05T16:05:35.000Z', invoice_id: 363, invoice_number: 'INV-0363' };

function apiGet(invoice) {
  api.get.mockImplementation((url) => {
    if (url === '/invoices/t/tok-1') return Promise.resolve({ data: { invoice } });
    if (url === '/stripe/publishable-key') return Promise.resolve({ data: { key: 'pk_test' } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

beforeEach(() => { api.get.mockReset(); api.post.mockReset(); confirmPayment.mockReset(); });

test('an invoice with a pending payment shows the processing card and no Pay button, no PAID stamp', async () => {
  apiGet({ ...baseInvoice, pending_payment: pending, pending_payment_for_this_invoice: true });
  const { container } = render(<InvoicePage />);
  await waitFor(() => expect(container.textContent).toMatch(/Your bank payment is processing/));
  expect(screen.queryByRole('button', { name: /^Pay \$/ })).toBeNull();
  expect(container.querySelector('.invoice-paid-stamp')).toBeNull();
  expect(container.textContent).not.toMatch(/Payment successful/);
});

test('a pending payment for another invoice on the proposal still hides Pay (D3)', async () => {
  apiGet({ ...baseInvoice, pending_payment: { ...pending, invoice_id: 999, invoice_number: 'INV-0999' }, pending_payment_for_this_invoice: false });
  const { container } = render(<InvoicePage />);
  await waitFor(() => expect(container.textContent).toMatch(/Your bank payment is processing/));
  expect(screen.queryByRole('button', { name: /^Pay \$/ })).toBeNull();
});

test('a confirm that resolves processing renders the card instead of Payment successful', async () => {
  apiGet(baseInvoice);
  api.post.mockResolvedValue({ data: { clientSecret: 'cs_1' } });
  confirmPayment.mockResolvedValue({ paymentIntent: { id: 'pi_1', status: 'processing', amount: 40000 } });
  const { container } = render(<InvoicePage />);
  await waitFor(() => screen.getByRole('button', { name: /^Pay \$400\.00/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Pay \$400\.00/ })); });
  await waitFor(() => screen.getByRole('button', { name: /Pay Now/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Pay Now/ })); });
  await waitFor(() => expect(container.textContent).toMatch(/Your bank payment is processing/));
  expect(container.textContent).toMatch(/\$400\.00 bank payment/);
  expect(container.textContent).not.toMatch(/Payment successful/);
  expect(container.querySelector('.invoice-paid-stamp')).toBeNull();
  expect(screen.queryByTestId('payment-element')).toBeNull();
});

test('a confirm that resolves succeeded still renders Payment successful (cards are unchanged)', async () => {
  apiGet(baseInvoice);
  api.post.mockResolvedValue({ data: { clientSecret: 'cs_1' } });
  confirmPayment.mockResolvedValue({ paymentIntent: { id: 'pi_1', status: 'succeeded', amount: 40000 } });
  const { container } = render(<InvoicePage />);
  await waitFor(() => screen.getByRole('button', { name: /^Pay \$400\.00/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Pay \$400\.00/ })); });
  await waitFor(() => screen.getByRole('button', { name: /Pay Now/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Pay Now/ })); });
  await waitFor(() => expect(container.textContent).toMatch(/Payment successful/));
  expect(container.textContent).not.toMatch(/bank payment is processing/);
});

test('a 409 PAYMENT_IN_FLIGHT from the rail shows its message and refetches the invoice', async () => {
  apiGet(baseInvoice);
  api.post.mockRejectedValue({ status: 409, code: 'PAYMENT_IN_FLIGHT', message: 'A $400.00 payment for this event has been processing since September 5. Bank payments take four to six business days to clear, and you will get a receipt by email when it does. If you think this is a mistake, email contact@drbartender.com.' });
  const { container } = render(<InvoicePage />);
  await waitFor(() => screen.getByRole('button', { name: /^Pay \$400\.00/ }));
  const getsBefore = api.get.mock.calls.filter(([u]) => u === '/invoices/t/tok-1').length;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Pay \$400\.00/ })); });
  await waitFor(() => expect(container.textContent).toMatch(/has been processing since September 5/));
  await waitFor(() => expect(api.get.mock.calls.filter(([u]) => u === '/invoices/t/tok-1').length).toBe(getsBefore + 1));
});
```

- [ ] **Step 2: Run to verify it fails**

Run from `client/`: `CI=true npx react-scripts test --testPathPattern=InvoicePage --watchAll=false`
Expected: the pending-card tests and the processing-confirm test FAIL; the succeeded test may pass.

- [ ] **Step 3: Edit `InvoicePage.js`**

Add the import: `import PendingPaymentCard from '../../components/PendingPaymentCard';`

Replace `PaymentForm` with:

```jsx
function PaymentForm({ onSuccess, onPending }) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setProcessing(true);
    setError('');

    const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: 'if_required',
    });

    if (stripeError) {
      setError(stripeError.message);
      setProcessing(false);
    } else if (paymentIntent && paymentIntent.status === 'processing') {
      // A bank debit (spec 2026-09-14 section 8.2): confirm returned no
      // error, but the money has not moved. Never "Payment successful".
      onPending({ amount_cents: paymentIntent.amount, started_at: new Date().toISOString(), invoice_id: null, invoice_number: null });
    } else {
      onSuccess();
    }
  };
  // ...the returned JSX is unchanged
```

In `InvoicePage`, add state after `paymentSuccess`:

```js
  // Bank debit in flight (spec 2026-09-14 section 8.2). Seeded from the
  // payload on load, set by the confirm result in the seconds before the
  // webhook lands. Any in-flight payment on the proposal hides Pay (D3).
  const [pendingPayment, setPendingPayment] = useState(null);
```

In the load effect, after `setInvoice(data.invoice);` add `setPendingPayment(data.invoice?.pending_payment || null);`.

Add a refetch helper above `handlePayClick`:

```js
  const refetchInvoice = useCallback(() => (
    api.get(`/invoices/t/${token}`).then(({ data }) => {
      setInvoice(data.invoice);
      setExtension(data.invoice?.extension || null);
      // Keep a locally known pending payment if the row does not carry one yet.
      setPendingPayment((cur) => data.invoice?.pending_payment || cur);
    }).catch(err => console.error('Invoice refetch failed:', err))
  ), [token]);
```

Change `handlePayClick`'s catch to:

```js
    } catch (err) {
      setFormError(err.message || 'Failed to initiate payment.');
      setFieldErrors(err.fieldErrors || {});
      if (err.code === 'PAYMENT_IN_FLIGHT') refetchInvoice();
    }
```

Add `handlePaymentPending` next to `handlePaymentSuccess`:

```js
  const handlePaymentPending = useCallback((pending) => {
    setPendingPayment(pending);
    setShowPayment(false);
    refetchInvoice();
  }, [refetchInvoice]);
```

and make `handlePaymentSuccess` use `refetchInvoice()` in place of its inline `api.get(...)` block.

In the render, after `const balanceDue = ...` add `const pending = !isPaid && !!pendingPayment;`. Then:

- the `Balance Due` summary block condition becomes `{!isPaid && !pending && balanceDue > 0 && (`
- add directly after the `isPaid` summary block: `{pending && <PendingPaymentCard amountCents={pendingPayment.amount_cents} startedAt={pendingPayment.started_at} />}`
- the Pay button condition becomes `{!isPaid && !pending && balanceDue > 0 && !showPayment && (`
- the payment-element condition becomes `{showPayment && !pending && !paymentBlockedByTerms && clientSecret && stripePromise && (` and passes `onPending={handlePaymentPending}` to `<PaymentForm>`.

The PAID stamp, `isPaid` and the success message are unchanged, so cards keep their exact behavior.

- [ ] **Step 4: Run the tests**

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/invoice/InvoicePage.js client/src/pages/invoice/InvoicePage.test.js
git commit -F - <<'MSG'
feat(invoice page): processing card for a bank debit, Pay hidden while in flight

Bank debit in flight, spec 2026-09-14 section 8.2.
MSG
```

---

### Task C3: `PaidCard` learns the pending phase

**Files:**
- Modify: `client/src/pages/proposal/proposalView/PaidCard.js`
- Test: `client/src/pages/proposal/proposalView/PaidCard.test.js` (append)

**Interfaces:**
- Produces: `phase` accepts `'pending'`; new prop `pendingPayment: null | { amount_cents, started_at }`.

- [ ] **Step 1: Write the failing tests**

Append to `PaidCard.test.js`:

```js
const pendingPayment = { amount_cents: 40000, started_at: '2026-09-05T16:05:35.000Z', invoice_id: 363, invoice_number: 'INV-0363' };

test('pending phase renders the processing card alone: no pay link, no paid claim', () => {
  const { container } = render(<PaidCard phase="pending" state={none} pendingPayment={pendingPayment} {...base} />);
  expect(container.textContent).toMatch(/Your bank payment is processing\./);
  expect(container.textContent).toMatch(/\$400\.00 bank payment on September 5/);
  expect(container.textContent).not.toMatch(/Deposit received|Fully paid|Confirming your payment/);
  expect(screen.queryByText(/Pay balance/)).toBeNull();
});

test('paid + deposit with a pending balance payment replaces the due-by line and hides Pay balance', () => {
  const { container } = render(<PaidCard phase="paid" state={deposit} pendingPayment={pendingPayment} {...base} openInvoiceToken="inv-tok" />);
  expect(container.textContent).toMatch(/Deposit received\./);
  expect(container.textContent).toMatch(/Your bank payment is processing\./);
  expect(container.textContent).not.toMatch(/is due by/);
  expect(screen.queryByText(/Pay balance/)).toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `CI=true npx react-scripts test --testPathPattern=PaidCard --watchAll=false`
Expected: both new tests FAIL.

- [ ] **Step 3: Edit `PaidCard.js`**

Add `import PendingPaymentCard from '../../../components/PendingPaymentCard';`. Add a fourth phase to the header comment: `//   pending   : a bank debit is processing (spec 2026-09-14). The shared card, no pay link, no paid claim.` Add `pendingPayment = null` to the destructured props. After the `fallback` block add:

```jsx
  if (phase === 'pending') {
    return <PendingPaymentCard amountCents={pendingPayment?.amount_cents} startedAt={pendingPayment?.started_at} />;
  }
```

In the paid branch, replace the non-autopay remaining-balance `<>...</>` with:

```jsx
        <>
          <h3 className="proposal-paid-title">{state.amountPaid > 0 ? 'Deposit received.' : 'Booking confirmed.'}</h3>
          {pendingPayment ? (
            <PendingPaymentCard amountCents={pendingPayment.amount_cents} startedAt={pendingPayment.started_at} />
          ) : (
            <p className="proposal-paid-sub">
              Your remaining balance of {fmt(state.remaining)} is due by {formatDateShort(balanceDueDate)}.
            </p>
          )}
        </>
```

and change the Pay balance condition to `{!isFullyPaid && !pendingPayment && openInvoiceToken && (`.

- [ ] **Step 4: Run the suite**

Expected: PASS, previous count plus two.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/proposal/proposalView/PaidCard.js client/src/pages/proposal/proposalView/PaidCard.test.js
git commit -F - <<'MSG'
feat(proposal page): PaidCard pending phase for a processing bank debit

Bank debit in flight, spec 2026-09-14 section 8.3.
MSG
```

---

### Task C4: The settle poll ends on a pending payment

**Files:**
- Modify: `client/src/pages/proposal/proposalView/settlePoll.js`
- Modify: `client/src/pages/proposal/proposalView/useSettle.js`
- Test: `settlePoll.test.js` and `useSettle.test.js` (append)

**Interfaces:**
- Produces: `pollPaymentState` returns `{ state, reason: 'pending' }` when `state.pending_payment` is set; `useSettle` accepts `onPending(fresh, pendingPayment)` and lands phase `'pending'`.

- [ ] **Step 1: Write the failing tests**

Append to `settlePoll.test.js`:

```js
test('a state carrying pending_payment is terminal with reason pending', async () => {
  const pendingState = { status: 'accepted', amount_paid: 0, total_price: 350, pending_payment: { amount_cents: 10000, started_at: '2026-09-05T16:05:35.000Z' } };
  const seq = [{ status: 'accepted', pending_payment: null }, pendingState];
  let calls = 0;
  const out = await pollPaymentState({ fetchState: async () => seq[calls++], sleep: noSleep });
  expect(out).toEqual({ state: pendingState, reason: 'pending' });
  expect(calls).toBe(2);
});
```

Append to `useSettle.test.js`:

```js
test('a pending payment ends the poll, refetches once, and lands the pending phase with the payment', async () => {
  const pendingPayment = { amount_cents: 10000, started_at: '2026-09-05T16:05:35.000Z' };
  const states = [{ status: 'accepted', pending_payment: null }, { status: 'accepted', pending_payment: pendingPayment }];
  let i = 0;
  const fetchState = jest.fn(async () => states[i++]);
  const freshRow = { ...staleRow, pending_payment: pendingPayment };
  const fetchProposal = jest.fn(async () => freshRow);
  const onPending = jest.fn();
  const onSettled = jest.fn();
  const { result } = renderHook(() => useSettle({ active: true, proposal: staleRow, fetchState, fetchProposal, onSettled, onFallback: jest.fn(), onPending, ...fast }));
  await waitFor(() => expect(result.current).toBe('pending'));
  expect(fetchState).toHaveBeenCalledTimes(2);
  expect(fetchProposal).toHaveBeenCalledTimes(1);
  expect(onPending).toHaveBeenCalledWith(freshRow, pendingPayment);
  expect(onSettled).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `CI=true npx react-scripts test --testPathPattern="settlePoll|useSettle" --watchAll=false`
Expected: both new tests FAIL (exhausted / fallback).

- [ ] **Step 3: Edit `settlePoll.js`**

Inside the `try`, after the `isPaidState` check, add:

```js
      // Bank debit in flight (spec 2026-09-14 section 8.3): a processing
      // payment is a terminal answer too. The webhook may be days away; the
      // page shows the processing card instead of twenty seconds of spinner.
      if (state && state.pending_payment) return { state, reason: 'pending' };
```

Update the header comment's first sentence to mention both terminal answers.

- [ ] **Step 4: Edit `useSettle.js`**

Extend the phase comment to `'idle' | 'settling' | 'paid' | 'fallback' | 'pending'`. Add `onPending` to the destructured props and to `latest.current`. After the `if (!state) { ... return; }` block and before the refetch, keep the refetch as is; then replace the `if (!isPaidState(fresh && fresh.status)) { ... }` block with:

```js
      if (reason === 'pending') {
        // The poll saw a processing payment. Hand the page the fresh row and
        // the payment (the row may not carry it yet if the webhook lagged the
        // state read by a beat) and land pending. Only the refetch failing
        // above earns fallback.
        safely('onPending', () => latest.current.onPending(fresh, (fresh && fresh.pending_payment) || state.pending_payment));
        setPhase('pending');
        return;
      }
      if (!isPaidState(fresh && fresh.status)) {
        setPhase('fallback');
        safely('onFallback', () => latest.current.onFallback('refetch_unsettled'));
        return;
      }
```

Give `onPending` a default so existing callers do not crash: in the signature, `onPending = () => {}`.

- [ ] **Step 5: Run both suites**

Expected: PASS, each previous count plus one.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/proposal/proposalView/settlePoll.js client/src/pages/proposal/proposalView/settlePoll.test.js client/src/pages/proposal/proposalView/useSettle.js client/src/pages/proposal/proposalView/useSettle.test.js
git commit -F - <<'MSG'
feat(proposal page): settle poll ends on a pending payment

Bank debit in flight, spec 2026-09-14 section 8.3. Retires the 2026-08-28
settle-page trap entry.
MSG
```

---

### Task C5: Extract `checkoutVisibility` and wire the proposal page

**Files:**
- Create: `client/src/pages/proposal/proposalView/checkoutVisibility.js`
- Test: `client/src/pages/proposal/proposalView/checkoutVisibility.test.js`
- Modify: `client/src/pages/proposal/proposalView/ProposalView.js` (lines 112 to 131; 199 to 227; 690 to 712; 874 to 884)

**Interfaces:**
- Consumes: `useSettle` `onPending` (C4); `PaidCard` `pendingPayment` (C3).
- Produces: `checkoutVisibility({ proposal, paid, settlePhase, isPaid, pendingPayment }) -> { settling, isPayableStatus, showSignAndPay, showPayOnly, showPaidCard, paidCardPhase }`.

- [ ] **Step 1: Write the failing test**

```js
// client/src/pages/proposal/proposalView/checkoutVisibility.test.js
import { checkoutVisibility } from './checkoutVisibility';

const unsignedSent = { status: 'sent', client_signed_at: null };
const signedAccepted = { status: 'accepted', client_signed_at: '2026-09-05T16:00:00Z' };
const depositPaid = { status: 'deposit_paid', client_signed_at: '2026-09-05T16:00:00Z' };
const pending = { amount_cents: 10000, started_at: '2026-09-05T16:05:35Z' };

test('plain visit, unsigned sent row: sign and pay is shown, nothing is settling', () => {
  const v = checkoutVisibility({ proposal: unsignedSent, paid: false, settlePhase: 'idle', isPaid: false, pendingPayment: null });
  expect(v).toEqual({ settling: false, isPayableStatus: true, showSignAndPay: true, showPayOnly: false, showPaidCard: false, paidCardPhase: 'settling' });
});

test('redirect landed on a signed accepted row: settling, no pay controls, spinner phase', () => {
  const v = checkoutVisibility({ proposal: signedAccepted, paid: true, settlePhase: 'settling', isPaid: false, pendingPayment: null });
  expect(v.settling).toBe(true);
  expect(v.isPayableStatus).toBe(false);
  expect(v.showSignAndPay).toBe(false);
  expect(v.showPayOnly).toBe(false);
  expect(v.showPaidCard).toBe(true);
  expect(v.paidCardPhase).toBe('settling');
});

test('fallback keeps the card and names the fallback phase', () => {
  const v = checkoutVisibility({ proposal: signedAccepted, paid: true, settlePhase: 'fallback', isPaid: false, pendingPayment: null });
  expect(v.paidCardPhase).toBe('fallback');
  expect(v.showPaidCard).toBe(true);
});

test('a pending payment on an unpaid row is a settling state with the pending card, no intents, no pay controls', () => {
  for (const proposal of [unsignedSent, signedAccepted]) {
    const v = checkoutVisibility({ proposal, paid: false, settlePhase: 'idle', isPaid: false, pendingPayment: pending });
    expect(v.settling).toBe(true);
    expect(v.isPayableStatus).toBe(false);
    expect(v.showSignAndPay).toBe(false);
    expect(v.showPayOnly).toBe(false);
    expect(v.showPaidCard).toBe(true);
    expect(v.paidCardPhase).toBe('pending');
  }
});

test('a paid row is the truth: paid phase whatever the poll or the pending flag says', () => {
  const v = checkoutVisibility({ proposal: depositPaid, paid: true, settlePhase: 'fallback', isPaid: true, pendingPayment: pending });
  expect(v).toEqual({ settling: false, isPayableStatus: false, showSignAndPay: false, showPayOnly: false, showPaidCard: true, paidCardPhase: 'paid' });
});

test('signed accepted row, plain visit, nothing pending: pay-only section', () => {
  const v = checkoutVisibility({ proposal: signedAccepted, paid: false, settlePhase: 'idle', isPaid: false, pendingPayment: null });
  expect(v.showPayOnly).toBe(true);
  expect(v.showSignAndPay).toBe(false);
  expect(v.isPayableStatus).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `CI=true npx react-scripts test --testPathPattern=checkoutVisibility --watchAll=false`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the module**

```js
// client/src/pages/proposal/proposalView/checkoutVisibility.js
// The proposal page's checkout gating, pure. Extracted from ProposalView.js
// (bank debit in flight, spec 2026-09-14 section 8.3) so the pending state is
// one more input, tested on its own, and the page is wiring.
//
// Inputs:
//   proposal      the loaded row (status, client_signed_at)
//   paid          a Stripe redirect landed and did not report failure (URL)
//   settlePhase   useSettle's phase: idle | settling | paid | fallback | pending
//   isPaid        paidState(row).kind !== 'none' (ROW truth)
//   pendingPayment  the row's pending_payment, or the poll's, or null
//
// A paid ROW wins over everything. A pending payment on an unpaid row is a
// settling state with a better card: no intents get minted, no pay controls
// show, and the pending card says what is happening.
const LIFECYCLE_PAID = ['deposit_paid', 'balance_paid', 'confirmed'];
const PAYABLE = ['sent', 'viewed', 'accepted'];

export function checkoutVisibility({ proposal, paid, settlePhase, isPaid, pendingPayment }) {
  const isAlreadySigned = !!(proposal && proposal.client_signed_at);
  const status = proposal ? proposal.status : null;
  const pending = !isPaid && !!pendingPayment;
  const settling = !isPaid && (pending || settlePhase === 'fallback' || (paid && isAlreadySigned));
  const isPayableStatus = !!proposal && !paid && !pending
    && !LIFECYCLE_PAID.includes(status) && PAYABLE.includes(status);
  const showSignAndPay = !isPaid && !settling && !isAlreadySigned && ['sent', 'viewed'].includes(status);
  const showPayOnly = !isPaid && !settling && isAlreadySigned && status === 'accepted';
  const showPaidCard = settling || isPaid;
  const paidCardPhase = isPaid ? 'paid'
    : pending ? 'pending'
      : settlePhase === 'fallback' ? 'fallback'
        : 'settling';
  return { settling, isPayableStatus, showSignAndPay, showPayOnly, showPaidCard, paidCardPhase };
}
```

- [ ] **Step 4: Run the test**

Expected: PASS, 6 tests.

- [ ] **Step 5: Wire `ProposalView.js`**

Add `import { checkoutVisibility } from './checkoutVisibility';`.

Near line 121, after `const paid = redirected && !redirectFailed;`, add:

```js
  // Bank debit in flight (spec 2026-09-14 section 8.3): the poll's pending
  // payment, kept until the row carries its own.
  const [settlePendingPayment, setSettlePendingPayment] = useState(null);
  const pendingPayment = (proposal && proposal.pending_payment) || settlePendingPayment || null;
```

Replace the `isPayableStatus` definition (lines 127 to 131) with:

```js
  // Row truth plus the redirect and the pending state. paidInfo is computed
  // further down from the row; here only the status matters, and the pure
  // helper reads that. Kept as a const so the intent effects below key on it.
  const isPayableStatus = checkoutVisibility({
    proposal, paid, settlePhase: 'idle', isPaid: false, pendingPayment,
  }).isPayableStatus;
```

Near line 208, after `onFallback`, add:

```js
  const onPending = useCallback((fresh, pending) => {
    if (fresh) setProposal(fresh);
    setSettlePendingPayment(pending || null);
  }, []);
```

and pass `onPending` into `useSettle({...})`.

Replace lines 704 to 710 (`const settling = ...` through `const showPayOnly = ...`) with:

```js
  const { settling, showSignAndPay, showPayOnly, showPaidCard, paidCardPhase } = checkoutVisibility({
    proposal, paid, settlePhase: settle, isPaid, pendingPayment,
  });
```

and delete the now-unused `isAlreadySigned` const if nothing else in the file reads it (grep first; if a later line uses it, keep it).

Replace the PaidCard block (lines 874 to 884) with:

```jsx
            {showPaidCard && (
              <PaidCard
                phase={paidCardPhase}
                state={paidInfo}
                pendingPayment={pendingPayment}
                autopayEnrolled={!!proposal.autopay_enrolled}
                balanceDueDate={balanceDueDate}
                openInvoiceToken={proposal.open_invoice_token || null}
                drinkPlanToken={proposal.drink_plan_token || null}
                onRefresh={() => window.location.assign(window.location.pathname)}
              />
            )}
```

Note `isPayableStatus` above is computed with `isPaid: false` because `paidInfo` is derived later in the file; that matches the previous definition, which never read `isPaid` either.

- [ ] **Step 6: Run the proposal-view suites and the size check**

Run: `CI=true npx react-scripts test --testPathPattern="proposalView" --watchAll=false`
Expected: PASS, all files. Then `wc -l client/src/pages/proposal/proposalView/ProposalView.js` must be at most 912.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/proposal/proposalView/checkoutVisibility.js client/src/pages/proposal/proposalView/checkoutVisibility.test.js client/src/pages/proposal/proposalView/ProposalView.js
git commit -F - <<'MSG'
feat(proposal page): pending payment gates checkout, checkoutVisibility extracted

Bank debit in flight, spec 2026-09-14 section 8.3.
MSG
```

---

### Task C6: The admin payment panel's Processing line

**Files:**
- Create: `client/src/pages/admin/PendingPaymentsList.js`
- Test: `client/src/pages/admin/PendingPaymentsList.test.js`
- Modify: `client/src/pages/admin/ProposalDetailPaymentPanel.js` (state near line 71; effect near line 78; render near line 415)

**Interfaces:**
- Consumes: `pending_payments` from `GET /invoices/proposal/:id` (server Task S10).
- Produces: `<PendingPaymentsList pendingPayments={array} />`, renders null when empty.

- [ ] **Step 1: Write the failing test**

```js
// client/src/pages/admin/PendingPaymentsList.test.js
import React from 'react';
import { render } from '@testing-library/react';
import PendingPaymentsList from './PendingPaymentsList';

test('renders nothing for an empty list', () => {
  const { container } = render(<PendingPaymentsList pendingPayments={[]} />);
  expect(container.textContent).toBe('');
});

test('renders one Processing line per in-flight payment, invoice number when known', () => {
  const { container } = render(<PendingPaymentsList pendingPayments={[
    { amount_cents: 40000, started_at: '2026-09-05T16:05:35.000Z', invoice_id: 363, invoice_number: 'INV-0363' },
    { amount_cents: 10000, started_at: '2026-08-30T21:13:14.000Z', invoice_id: null, invoice_number: null },
  ]} />);
  const t = container.textContent;
  expect(t).toMatch(/Processing: \$400\.00 bank payment, started Sep 5, INV-0363/);
  expect(t).toMatch(/Processing: \$100\.00 bank payment, started Aug 30/);
  expect(t).not.toMatch(/—/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `CI=true npx react-scripts test --testPathPattern=PendingPaymentsList --watchAll=false`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the component**

```jsx
// client/src/pages/admin/PendingPaymentsList.js
import React from 'react';

// Bank debit in flight (spec 2026-09-14 section 10): one line per payment
// still processing on the proposal, above the invoice list in the payment
// panel, so a "did my payment go through" call is answered without opening
// Stripe. amount_cents is cents; started_at is an instant.
function dollars(cents) {
  return (Number(cents || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
function started(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export default function PendingPaymentsList({ pendingPayments }) {
  if (!pendingPayments || pendingPayments.length === 0) return null;
  return (
    <div className="vstack" style={{ gap: 4, marginBottom: 8 }}>
      {pendingPayments.map((p, i) => (
        <div key={`${p.started_at}-${i}`} className="tiny" style={{ color: 'var(--amber-700, #8a5a00)' }}>
          Processing: {dollars(p.amount_cents)} bank payment, started {started(p.started_at)}{p.invoice_number ? `, ${p.invoice_number}` : ''}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Wire the panel**

Add `import PendingPaymentsList from './PendingPaymentsList';`. Next to `const [invoices, setInvoices] = useState([]);` add `const [pendingPayments, setPendingPayments] = useState([]);`. In the invoices effect change the `.then` to:

```js
      .then(res => {
        if (!alive) return;
        setInvoices(res.data.invoices || []);
        setPendingPayments(res.data.pending_payments || []);
      })
```

In the render, directly before `<InvoiceDropdown proposalId={proposal.id} invoices={invoices} />`, add `<PendingPaymentsList pendingPayments={pendingPayments} />`.

- [ ] **Step 5: Run the test**

Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/admin/PendingPaymentsList.js client/src/pages/admin/PendingPaymentsList.test.js client/src/pages/admin/ProposalDetailPaymentPanel.js
git commit -F - <<'MSG'
feat(admin): Processing line for in-flight bank payments on the payment panel

Bank debit in flight, spec 2026-09-14 section 10.
MSG
```

---

### Task C7: README tree and the full client run

**Files:**
- Modify: `README.md` (the `client/src/components/` block near line 574; the admin pages block)

- [ ] **Step 1: README**

In the `components/` block add, in alphabetical position: `│   │   │   ├── PendingPaymentCard.js # "Your bank payment is processing." shared by the invoice and proposal pages (spec 2026-09-14)`. In the admin pages block next to `ProposalDetailPaymentPanel.js` add `PendingPaymentsList.js # Processing lines above the invoice list`. In the proposal view block next to `settlePoll.js` add `checkoutVisibility.js # pure checkout gating (settling / pending / pay controls)`.

- [ ] **Step 2: Run every client suite the lane reaches**

Run from `client/`: `CI=true npx react-scripts test --testPathPattern="PendingPaymentCard|InvoicePage|proposalView|PendingPaymentsList" --watchAll=false`
Expected: PASS, every file, no console errors about act().

- [ ] **Step 3: Lint the client the way CI does**

Run from `client/`: `CI=true npx react-scripts build`
Expected: builds with no ESLint warnings (CI treats warnings as errors). Fix any unused import this lane left behind.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -F - <<'MSG'
docs(readme): client files for bank debit in flight
MSG
```

---

## Review round, 2026-09-14

Both lanes were built as written and reviewed by the full fleet before merge. The fleet's findings and the fixes are recorded in spec sections 5.1 (third rail), 8.3 (pending copy, invoice confirm statuses) and 8.4 (drink-plan celebration screens); the footprints above carry the extra files. Two plan corrections found in execution: `ExternalServiceError` is HTTP 502, not 503 (Tasks S3 and S6 assert 502), and `invoices.invoice_number` is VARCHAR(20), so fixtures use a 16-character number.

## Self-review against the spec

- 3.1 schema, manifest, ARCHITECTURE: S1. 3.2 helper: S3. 4.1 handler and dispatch: S5. 4.2 unchanged handlers: stated. 4.3 endpoint subscription: rollout step after the push cue, not a lane task (it is a live Stripe change made from this box; see the spec). 5.1 both rails: S6, S7. 5.2 widened readers: S8. 5.3 reader audit: S12. 6 reminders: S2, S9. 7 payloads: S10. 8.1 card: C1. 8.2 invoice page: C2. 8.3 PaidCard, poll, hook, ProposalView: C3, C4, C5. 9 email: S4. 10 admin: activity row in S5, panel in C6 and S10. 11 tests: inside every task; the reached-suite run is S12 and C7. 12 walkthroughs owed: S11. 13 docs and fix list: S11, C7. 14 out of scope: nothing here touches it.
- Names used across tasks: `findInFlightPayments`, `toPublicPending`, `assertNoInFlightPayment`, `assertNoIntentSettlingAtStripe`, `inFlightMessage` (S3, used in S6, S7, S9, S10); `DeferMessageError` (S2, used in S9); `notifyClientBankPaymentProcessing` (S4, used in S5); `bankPaymentProcessingClient` (S4); `pending_payment` / `pending_payment_for_this_invoice` / `pending_payments` (S10, used in C2, C3, C4, C5, C6); `PendingPaymentCard` (C1, used in C2, C3); `onPending` (C4, used in C5); `checkoutVisibility` (C5).
