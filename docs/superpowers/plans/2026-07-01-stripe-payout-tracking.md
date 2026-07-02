---
spec: docs/superpowers/specs/2026-07-01-stripe-payout-tracking-design.md
gate: "EXTERNAL — do not cut lanes until the proposal-options windows have pushed (stripeWebhook.js and client-admin commits clear of origin/main backlog)"
lanes:
  - id: stripe-payouts-server
    footprint:
      - server/db/schema.sql
      - server/utils/stripePayoutSync.js
      - server/utils/stripePayoutSync.test.js
      - server/routes/stripePayouts.js
      - server/routes/stripePayouts.test.js
      - server/routes/stripeWebhook.js
      - server/routes/stripeWebhook.payout.test.js
      - server/utils/adminNotifications.js
      - server/scripts/backfillStripePayouts.js
      - server/index.js
      - .env.example
      - README.md
      - ARCHITECTURE.md
      - .claude/CLAUDE.md
    blockedBy: []
    review: full-fleet   # code + security + database + performance + consistency, max effort (money + webhook + schema)
  - id: stripe-payouts-client
    footprint:
      - client/src/pages/admin/StripePayoutsTab.js
      - client/src/pages/admin/FinancialsDashboard.js
      - client/src/pages/admin/NotificationSettings.js
    blockedBy: []       # builds in parallel against the API contract below; merge after server lane; push together
    review: code-review + ui-ux-review (read-only UI; no money mutation)
---

# Stripe Payout Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror Stripe payouts and their balance-transaction lines into two new read-side tables, reconcile every line back to payments/tips/refunds/disputes, and surface it as a "Stripe Payouts" tab on FinancialsDashboard with an in-transit bucket, fee rollups, and a failed-payout email alert.

**Architecture:** One sync module (`stripePayoutSync.js`) owns all ingest through idempotent upserts keyed on Stripe ids; three callers (webhook branches, nightly sweep, backfill script) plus a client-driven refresh converge on it. Strictly read-side: no existing table is ever written. The client tab consumes a DB-only GET and a sweep-triggering POST.

**Tech Stack:** Express + pg raw SQL, Stripe SDK via `stripeClient.js`, node:test, React (CRA) with existing adminos components.

## Global Constraints

- All money INTEGER CENTS end to end; display converts via `fmt$fromCents`.
- `stripe_` prefix everywhere (tables, files, routes, UI copy "Stripe Payouts") — plain "payouts" means payroll in this codebase.
- Stripe access ONLY via `server/utils/stripeClient.js` (`getStripe()`); never `require('stripe')`.
- Read-side only: the ONLY existing files modified are `stripeWebhook.js` (two new branches), `adminNotifications.js` (one category string), `index.js` (mount + scheduler), and the two client pages. No writes to any existing table.
- All SQL parameterized. Schema DDL idempotent (`IF NOT EXISTS`).
- API JSON keys snake_case.
- Server tests: node:test, run ONE SUITE AT A TIME with `node -r dotenv/config <file>` (shared dev DB); NONCE-scoped fixtures, cleaned in `after()`.
- No em dashes in client copy.
- Ownership rule (load-bearing): only `syncPayout` ever sets or changes `payout_id` on a line. The pending path is insert-only `ON CONFLICT DO NOTHING`.
- Livemode: ingest skips objects with `livemode: false`; backfill refuses to run in test mode.
- Max reasoning effort throughout (money + webhook + schema).

## API contract (the seam between the two lanes)

`GET /api/stripe-payouts` (auth + requireAdminOrManager, DB-only, never calls Stripe):

```json
{
  "summary": {
    "in_transit_cents": 63055,
    "fees_mtd_cents": 1655,
    "fees_ytd_cents": 48210,
    "unmatched_count": 0,
    "last_synced_at": "2026-07-01T18:22:05.000Z"
  },
  "pending": [
    { "id": 7, "stripe_balance_txn_id": "txn_...", "amount_cents": 45000,
      "fee_cents": 1335, "net_cents": 43665, "available_on": "2026-07-03T00:00:00.000Z",
      "description": "INV-0091 — Allyson Gietl", "matched_kind": "payment",
      "proposal_id": 321, "client_name": "Allyson Gietl", "event_type": "wedding",
      "event_type_custom": null, "invoice_id": 91, "invoice_number": "INV-0091",
      "invoice_token": "uuid", "staff_name": null }
  ],
  "payouts": [
    { "id": 3, "stripe_payout_id": "po_...", "amount_cents": 53345, "status": "paid",
      "arrival_date": "2026-06-30", "created_at_stripe": "2026-06-30T00:39:31.000Z",
      "gross_cents": 55000, "fee_cents": 1655, "line_count": 2,
      "failure_message": null }
  ]
}
```

`GET /api/stripe-payouts/:id` (same auth; `:id` = integer PK):

```json
{ "payout": { same shape as list row }, "lines": [ same shape as pending rows ] }
```

`POST /api/stripe-payouts/sync` (same auth + `adminWriteLimiter`): body `{ "force": true }` optional. Runs `sweep({ force })` through the module's shared in-flight guard; without `force`, the module SKIPS the sweep when the last one finished under 15 minutes ago. Returns `{ "synced": true|false, "last_synced_at": "..." }` (`synced: false` = fresh, skipped).

Staleness lives SERVER-side in the module (`lastSweepAt` + in-flight promise). The tab always POSTs /sync on open (no force) and lets the module decide; the "Sync now" button sends `force: true`.

---

# Lane: stripe-payouts-server

### Task 1: Schema — `stripe_payouts` + `stripe_payout_lines`

**Files:**
- Modify: `server/db/schema.sql` (append at end, before any trailing comment block)

**Interfaces:**
- Produces: the two tables exactly as below; every later task's SQL depends on these column names.

- [ ] **Step 1: Append the DDL to `server/db/schema.sql`**

```sql
-- ============================================================
-- Stripe payout tracking (read-side mirror; spec 2026-07-01)
-- "stripe_" prefix is load-bearing: plain "payouts" = staff payroll.
-- ============================================================
CREATE TABLE IF NOT EXISTS stripe_payouts (
  id SERIAL PRIMARY KEY,
  stripe_payout_id TEXT UNIQUE NOT NULL,          -- po_...
  amount_cents INTEGER NOT NULL,                  -- net amount that lands in bank
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL,                           -- paid | in_transit | pending | canceled | failed
  created_at_stripe TIMESTAMPTZ NOT NULL,
  arrival_date DATE,
  automatic BOOLEAN NOT NULL DEFAULT true,
  livemode BOOLEAN NOT NULL DEFAULT true,         -- ingest skips non-live; column is the tripwire
  method TEXT,
  description TEXT,
  failure_code TEXT,
  failure_message TEXT,
  alerted_at TIMESTAMPTZ,                         -- failed-payout alert atomic-claim gate
  lines_synced_at TIMESTAMPTZ,                    -- NULL until balance txns fetched; sweep heals NULLs
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stripe_payout_lines (
  id SERIAL PRIMARY KEY,
  stripe_balance_txn_id TEXT UNIQUE NOT NULL,     -- txn_...
  payout_id INTEGER REFERENCES stripe_payouts(id) ON DELETE CASCADE,  -- NULL = in transit
  txn_type TEXT NOT NULL,
  reporting_category TEXT,
  amount_cents INTEGER NOT NULL,                  -- signed gross (refunds/disputes negative)
  fee_cents INTEGER NOT NULL DEFAULT 0,
  net_cents INTEGER NOT NULL,
  available_on TIMESTAMPTZ,
  description TEXT,
  stripe_charge_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_refund_id TEXT,
  matched_kind TEXT NOT NULL DEFAULT 'unmatched'
    CHECK (matched_kind IN ('payment','tip','refund','dispute','adjustment','unmatched')),
  proposal_payment_id INTEGER REFERENCES proposal_payments(id) ON DELETE SET NULL,
  tip_id INTEGER REFERENCES tips(id) ON DELETE SET NULL,
  proposal_refund_id INTEGER REFERENCES proposal_refunds(id) ON DELETE SET NULL,
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stripe_payout_lines_payout ON stripe_payout_lines(payout_id);
CREATE INDEX IF NOT EXISTS idx_stripe_payout_lines_pi ON stripe_payout_lines(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_stripe_payout_lines_unmatched ON stripe_payout_lines(matched_kind) WHERE matched_kind = 'unmatched';
```

- [ ] **Step 2: Apply to the dev DB and verify**

Restart the managed dev server (initDb applies schema.sql on boot). If the tables do not appear (known dev quirk from the F1b lesson), apply the DDL above by hand against the Neon `dev` branch. Verify:

Run: `node -r dotenv/config -e "require('./server/db').pool.query(\"SELECT to_regclass('stripe_payouts') a, to_regclass('stripe_payout_lines') b\").then(r=>{console.log(r.rows[0]);process.exit(0)})"`
Expected: `{ a: 'stripe_payouts', b: 'stripe_payout_lines' }`

- [ ] **Step 3: Commit (lane checkpoint)**

```bash
git add server/db/schema.sql
git commit -m "feat(stripe-payouts): schema — stripe_payouts + stripe_payout_lines mirror tables"
```

### Task 2: Sync module core — upserts, pending path, ownership rule

**Files:**
- Create: `server/utils/stripePayoutSync.js`
- Test: `server/utils/stripePayoutSync.test.js`

**Interfaces:**
- Consumes: Task 1 tables; `getStripe` from `server/utils/stripeClient.js`; `pool` from `server/db`.
- Produces (used by Tasks 3-7 and the webhook):
  - `syncPayout(payoutObj, { stripe } = {})` → upserts the payout row; when `status === 'paid'` fetches + upserts its lines (claiming `payout_id`), matches each, sets `lines_synced_at`. Skips `livemode: false` (returns `{ skipped: 'livemode' }`).
  - `syncPendingTransactions({ stripe } = {})` → inserts recent non-payout balance txns as `payout_id NULL` lines, `ON CONFLICT DO NOTHING`, matches new ones.
  - `sweep({ stripe, notify } = {})` → 30-day re-check (full-history bootstrap when table empty), heals `lines_synced_at IS NULL`, runs `syncPendingTransactions`, re-matches unmatched, alerts failed payouts. Shared in-flight promise; sets module `lastSweepAt`.
  - `alertFailedPayout(stripePayoutId, { notify } = {})` → atomic `alerted_at` claim, then `notifyAdminCategory`.
  - `getLastSweepAt()` → ISO string or null.
  - `_setStripeClientForTests(fake)` → throws unless `NODE_ENV !== 'production'`.

- [ ] **Step 1: Write the failing tests (upsert + ownership subset)**

Create `server/utils/stripePayoutSync.test.js`:

```js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const sync = require('./stripePayoutSync');

if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');

const N = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const poId = `po_test_${N}`;
const txnA = `txn_test_${N}_a`;
const txnB = `txn_test_${N}_b`;

// Fake Stripe client: only the surface the module touches.
function fakeStripe({ payouts = [], txnsByPayout = {}, recentTxns = [] } = {}) {
  const page = (arr) => ({ data: arr, has_more: false });
  return {
    payouts: { list: async () => page(payouts) },
    balanceTransactions: {
      list: async (params = {}) => page(params.payout ? (txnsByPayout[params.payout] || []) : recentTxns),
    },
  };
}
const payoutObj = (over = {}) => ({
  id: poId, object: 'payout', amount: 53345, currency: 'usd', status: 'paid',
  created: 1782776371, arrival_date: 1782777600, automatic: true, livemode: true,
  method: 'standard', description: 'STRIPE PAYOUT', failure_code: null, failure_message: null,
  ...over,
});
const chargeTxn = (id, over = {}) => ({
  id, object: 'balance_transaction', type: 'charge', reporting_category: 'charge',
  amount: 45000, fee: 1335, net: 43665, available_on: 1782604800,
  description: `test charge ${N}`,
  source: { id: `ch_test_${N}`, object: 'charge', payment_intent: `pi_test_${N}` },
  ...over,
});

after(async () => {
  await pool.query('DELETE FROM stripe_payout_lines WHERE stripe_balance_txn_id LIKE $1', [`txn_test_${N}%`]);
  await pool.query('DELETE FROM stripe_payouts WHERE stripe_payout_id = $1', [poId]);
  await pool.end();
});

test('syncPayout upserts payout row and claims its lines; double-run converges', async () => {
  const stripe = fakeStripe({ txnsByPayout: { [poId]: [
    { id: `txn_test_${N}_self`, type: 'payout', reporting_category: 'payout', amount: -53345, fee: 0, net: -53345, source: poId },
    chargeTxn(txnA),
  ] } });
  await sync.syncPayout(payoutObj(), { stripe });
  await sync.syncPayout(payoutObj(), { stripe }); // replay
  const p = (await pool.query('SELECT * FROM stripe_payouts WHERE stripe_payout_id=$1', [poId])).rows;
  assert.equal(p.length, 1);
  assert.equal(p[0].amount_cents, 53345);
  assert.ok(p[0].lines_synced_at);
  const l = (await pool.query('SELECT * FROM stripe_payout_lines WHERE stripe_balance_txn_id LIKE $1', [`txn_test_${N}%`])).rows;
  assert.equal(l.length, 1); // the payout's own txn is skipped
  assert.equal(l[0].payout_id, p[0].id);
});

test('syncPayout skips livemode:false', async () => {
  const r = await sync.syncPayout(payoutObj({ id: `po_test_${N}_tm`, livemode: false }), { stripe: fakeStripe() });
  assert.equal(r.skipped, 'livemode');
  const p = await pool.query('SELECT 1 FROM stripe_payouts WHERE stripe_payout_id=$1', [`po_test_${N}_tm`]);
  assert.equal(p.rows.length, 0);
});

test('pending path inserts with NULL payout_id and NEVER un-claims a claimed line', async () => {
  const stripe = fakeStripe({ recentTxns: [chargeTxn(txnA), chargeTxn(txnB, { amount: 10000, fee: 320, net: 9680 })] });
  await sync.syncPendingTransactions({ stripe });
  const rows = (await pool.query(
    'SELECT stripe_balance_txn_id, payout_id FROM stripe_payout_lines WHERE stripe_balance_txn_id IN ($1,$2) ORDER BY stripe_balance_txn_id',
    [txnA, txnB])).rows;
  // txnA was claimed by the payout in the earlier test and MUST keep its payout_id.
  assert.ok(rows.find(r => r.stripe_balance_txn_id === txnA).payout_id, 'pending path un-claimed a settled line');
  assert.equal(rows.find(r => r.stripe_balance_txn_id === txnB).payout_id, null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node -r dotenv/config server/utils/stripePayoutSync.test.js`
Expected: FAIL (`Cannot find module './stripePayoutSync'`)

- [ ] **Step 3: Implement the module core**

Create `server/utils/stripePayoutSync.js`:

```js
/**
 * Stripe payout tracking — read-side mirror sync (spec 2026-07-01).
 * All ingest paths converge here through idempotent upserts keyed on Stripe ids.
 * OWNERSHIP RULE: only syncPayout ever sets/changes payout_id on a line; the
 * pending path is insert-only (ON CONFLICT DO NOTHING), or it would un-claim
 * settled lines and flip them back to "in transit".
 */
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { getStripe } = require('./stripeClient');
const { notifyAdminCategory } = require('./adminNotifications');

const RECHECK_DAYS = 30;
let lastSweepAt = null;
let inFlight = null;
let testStripe = null;

function _setStripeClientForTests(fake) {
  if (process.env.NODE_ENV === 'production') throw new Error('test hook disabled in production');
  testStripe = fake;
}
function client(opts) { return (opts && opts.stripe) || testStripe || getStripe(); }
const ts = (unix) => (unix ? new Date(unix * 1000) : null);

async function listAll(listFn, params) {
  const out = [];
  let starting_after;
  for (;;) {
    const page = await listFn({ limit: 100, ...params, ...(starting_after ? { starting_after } : {}) });
    out.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    starting_after = page.data[page.data.length - 1].id;
  }
  return out;
}

function lineFieldsFromTxn(txn) {
  const src = (txn.source && typeof txn.source === 'object') ? txn.source : {};
  const srcId = typeof txn.source === 'string' ? txn.source : (src.id || null);
  return {
    txn_type: txn.type,
    reporting_category: txn.reporting_category || null,
    amount_cents: txn.amount,
    fee_cents: txn.fee || 0,
    net_cents: txn.net,
    available_on: ts(txn.available_on),
    description: txn.description || null,
    stripe_charge_id: src.charge || (srcId && srcId.startsWith('ch_') ? srcId : null),
    stripe_payment_intent_id: src.payment_intent || null,
    stripe_refund_id: srcId && srcId.startsWith('re_') ? srcId : null,
  };
}

async function upsertPayoutRow(p) {
  const { rows } = await pool.query(
    `INSERT INTO stripe_payouts (stripe_payout_id, amount_cents, currency, status,
       created_at_stripe, arrival_date, automatic, livemode, method, description,
       failure_code, failure_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (stripe_payout_id) DO UPDATE SET
       status = EXCLUDED.status, arrival_date = EXCLUDED.arrival_date,
       failure_code = EXCLUDED.failure_code, failure_message = EXCLUDED.failure_message,
       updated_at = NOW()
     RETURNING id, lines_synced_at`,
    [p.id, p.amount, p.currency || 'usd', p.status, ts(p.created), ts(p.arrival_date),
     p.automatic !== false, p.livemode !== false, p.method || null, p.description || null,
     p.failure_code || null, p.failure_message || null]);
  return rows[0];
}

// Claiming upsert — the ONLY place payout_id is ever written.
async function upsertLineForPayout(payoutRowId, f) {
  const { rows } = await pool.query(
    `INSERT INTO stripe_payout_lines (stripe_balance_txn_id, payout_id, txn_type,
       reporting_category, amount_cents, fee_cents, net_cents, available_on, description,
       stripe_charge_id, stripe_payment_intent_id, stripe_refund_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (stripe_balance_txn_id) DO UPDATE SET payout_id = EXCLUDED.payout_id, updated_at = NOW()
     RETURNING id, matched_kind`,
    [f.id, payoutRowId, f.txn_type, f.reporting_category, f.amount_cents, f.fee_cents,
     f.net_cents, f.available_on, f.description, f.stripe_charge_id,
     f.stripe_payment_intent_id, f.stripe_refund_id]);
  return rows[0];
}

// Pending path — insert-only by design (ownership rule).
async function insertPendingLine(f) {
  const { rows } = await pool.query(
    `INSERT INTO stripe_payout_lines (stripe_balance_txn_id, payout_id, txn_type,
       reporting_category, amount_cents, fee_cents, net_cents, available_on, description,
       stripe_charge_id, stripe_payment_intent_id, stripe_refund_id)
     VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (stripe_balance_txn_id) DO NOTHING
     RETURNING id`,
    [f.id, f.txn_type, f.reporting_category, f.amount_cents, f.fee_cents, f.net_cents,
     f.available_on, f.description, f.stripe_charge_id, f.stripe_payment_intent_id,
     f.stripe_refund_id]);
  return rows[0] || null; // null = already existed
}

async function syncPayout(payoutObj, opts = {}) {
  if (payoutObj.livemode === false) return { skipped: 'livemode' };
  const stripe = client(opts);
  const row = await upsertPayoutRow(payoutObj);
  if (payoutObj.status === 'paid') {
    const txns = await listAll(
      (p) => stripe.balanceTransactions.list({ ...p, payout: payoutObj.id, expand: ['data.source'] }), {});
    for (const txn of txns) {
      if (txn.type === 'payout') continue; // the payout's own negative txn
      const line = await upsertLineForPayout(row.id, { id: txn.id, ...lineFieldsFromTxn(txn) });
      await matchLine(line.id); // Task 3
    }
    await pool.query('UPDATE stripe_payouts SET lines_synced_at = NOW(), updated_at = NOW() WHERE id = $1', [row.id]);
  }
  return { id: row.id };
}

async function syncPendingTransactions(opts = {}) {
  const stripe = client(opts);
  const since = Math.floor(Date.now() / 1000) - RECHECK_DAYS * 86400;
  const txns = await listAll(
    (p) => stripe.balanceTransactions.list({ ...p, created: { gte: since }, expand: ['data.source'] }), {});
  for (const txn of txns) {
    if (txn.type === 'payout') continue;
    const inserted = await insertPendingLine({ id: txn.id, ...lineFieldsFromTxn(txn) });
    if (inserted) await matchLine(inserted.id);
  }
}

module.exports = {
  syncPayout, syncPendingTransactions, matchLine, sweep, alertFailedPayout,
  getLastSweepAt: () => lastSweepAt,
  _setStripeClientForTests,
};
```

(`matchLine`, `sweep`, `alertFailedPayout` are added in Tasks 3-4; for this step stub `matchLine = async () => {}` and `sweep`/`alertFailedPayout` as `async () => { throw new Error('not implemented'); }` so the module loads and this task's tests pass.)

- [ ] **Step 4: Run the tests**

Run: `node -r dotenv/config server/utils/stripePayoutSync.test.js`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/utils/stripePayoutSync.js server/utils/stripePayoutSync.test.js
git commit -m "feat(stripe-payouts): sync module core — claiming upserts, insert-only pending path"
```

### Task 3: Matcher — the reconciliation spine

**Files:**
- Modify: `server/utils/stripePayoutSync.js` (replace the `matchLine` stub)
- Test: `server/utils/stripePayoutSync.test.js` (append cases)

**Interfaces:**
- Consumes: `proposal_payments.stripe_payment_intent_id`, `tips.stripe_payment_intent_id`, `proposal_refunds.stripe_refund_id` + `.proposal_id` (direct NOT NULL FK), `invoice_payments(payment_id, invoice_id)`.
- Produces: `matchLine(lineId)` → updates `matched_kind` + link FKs on that line. Kinds: `payment`, `tip`, `refund`, `dispute`, `adjustment`, `unmatched`.

- [ ] **Step 1: Append failing matcher tests**

Append to `stripePayoutSync.test.js` (inside the same NONCE scope; create fixtures in `before()`):

```js
// Fixtures: one client+proposal+payment (with PI), one invoice link, one refund, one tip.
let proposalId, paymentId, invoiceId, refundId, tipId, userId;
before(async () => {
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id`,
    [`PayoutTest ${N}`, `payout-test-${N}@test.local`]);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_type, status) VALUES ($1,'cocktail_party','confirmed') RETURNING id`,
    [c.rows[0].id]);
  proposalId = p.rows[0].id;
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
     VALUES ($1,$2,'deposit',45000,'succeeded') RETURNING id`, [proposalId, `pi_test_${N}`]);
  paymentId = pay.rows[0].id;
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due) VALUES ($1,$2,'Invoice',45000) RETURNING id`,
    [proposalId, `INV-T${String(N).slice(-6)}`]);
  invoiceId = inv.rows[0].id;
  await pool.query(`INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1,$2,45000)`,
    [invoiceId, paymentId]);
  const ref = await pool.query(
    `INSERT INTO proposal_refunds (proposal_id, payment_id, amount_cents, stripe_refund_id)
     VALUES ($1,$2,5000,$3) RETURNING id`, [proposalId, paymentId, `re_test_${N}`]);
  refundId = ref.rows[0].id;
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1,'x','staff') RETURNING id`,
    [`payout-tip-${N}@test.local`]);
  userId = u.rows[0].id;
  const tip = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, stripe_payment_intent_id, tipped_at)
     VALUES (gen_random_uuid(),$1,2000,$2,NOW()) RETURNING id`, [userId, `pi_tip_${N}`]);
  tipId = tip.rows[0].id;
});
// Extend after() cleanup with (delete order matters for FKs):
//   stripe_payout_lines (already), invoice_payments, proposal_refunds, invoices,
//   proposal_payments, tips, proposals, clients, users — all WHERE keyed on N.

async function makePendingLine(id, fields) {
  const { rows } = await pool.query(
    `INSERT INTO stripe_payout_lines (stripe_balance_txn_id, txn_type, reporting_category,
       amount_cents, fee_cents, net_cents, stripe_charge_id, stripe_payment_intent_id, stripe_refund_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [id, fields.txn_type || 'charge', fields.reporting_category || 'charge',
     fields.amount_cents ?? 1000, fields.fee_cents ?? 30, fields.net_cents ?? 970,
     fields.stripe_charge_id || null, fields.stripe_payment_intent_id || null,
     fields.stripe_refund_id || null]);
  return rows[0].id;
}
const lineRow = async (id) =>
  (await pool.query('SELECT * FROM stripe_payout_lines WHERE id=$1', [id])).rows[0];

test('matcher: charge with known PI -> payment + proposal + invoice', async () => {
  const id = await makePendingLine(`txn_test_${N}_m1`, { stripe_payment_intent_id: `pi_test_${N}` });
  await sync.matchLine(id);
  const r = await lineRow(id);
  assert.equal(r.matched_kind, 'payment');
  assert.equal(r.proposal_payment_id, paymentId);
  assert.equal(r.proposal_id, proposalId);
  assert.equal(r.invoice_id, invoiceId);
});

test('matcher: charge with tip PI -> tip', async () => {
  const id = await makePendingLine(`txn_test_${N}_m2`, { stripe_payment_intent_id: `pi_tip_${N}` });
  await sync.matchLine(id);
  const r = await lineRow(id);
  assert.equal(r.matched_kind, 'tip');
  assert.equal(r.tip_id, tipId);
});

test('matcher: refund txn -> refund with proposal from the refund row', async () => {
  const id = await makePendingLine(`txn_test_${N}_m3`, {
    txn_type: 'refund', reporting_category: 'refund',
    amount_cents: -5000, net_cents: -5000, fee_cents: 0, stripe_refund_id: `re_test_${N}` });
  await sync.matchLine(id);
  const r = await lineRow(id);
  assert.equal(r.matched_kind, 'refund');
  assert.equal(r.proposal_refund_id, refundId);
  assert.equal(r.proposal_id, proposalId);
});

test('matcher: dispute txn resolves via PI as dispute', async () => {
  const id = await makePendingLine(`txn_test_${N}_m4`, {
    txn_type: 'adjustment', reporting_category: 'dispute',
    amount_cents: -45000, net_cents: -46500, fee_cents: 1500,
    stripe_payment_intent_id: `pi_test_${N}` });
  await sync.matchLine(id);
  const r = await lineRow(id);
  assert.equal(r.matched_kind, 'dispute');
  assert.equal(r.proposal_payment_id, paymentId);
});

test('matcher: adjustment category -> adjustment even without links', async () => {
  const id = await makePendingLine(`txn_test_${N}_m5`, {
    txn_type: 'adjustment', reporting_category: 'other_adjustment', amount_cents: -100, net_cents: -100, fee_cents: 0 });
  await sync.matchLine(id);
  assert.equal((await lineRow(id)).matched_kind, 'adjustment');
});

test('matcher: unknown PI stays unmatched', async () => {
  const id = await makePendingLine(`txn_test_${N}_m6`, { stripe_payment_intent_id: `pi_nope_${N}` });
  await sync.matchLine(id);
  assert.equal((await lineRow(id)).matched_kind, 'unmatched');
});
```

NOTE for the implementer: the `clients`/`proposals` INSERT column lists above are the minimal shape; check `schema.sql` for NOT NULL columns on those tables and add any required values (mirror an existing route test's fixture INSERTs, e.g. `stripeWebhook.optionGroup.test.js`).

- [ ] **Step 2: Run to verify the new cases fail**

Run: `node -r dotenv/config server/utils/stripePayoutSync.test.js`
Expected: earlier tests PASS, matcher tests FAIL (stub does nothing)

- [ ] **Step 3: Implement `matchLine`**

Replace the stub in `stripePayoutSync.js`:

```js
async function matchLine(lineId) {
  const { rows } = await pool.query('SELECT * FROM stripe_payout_lines WHERE id = $1', [lineId]);
  const line = rows[0];
  if (!line) return;
  const cat = line.reporting_category || line.txn_type;
  let kind = 'unmatched';
  let paymentId = null, tipId = null, refundId = null, proposalId = null, invoiceId = null;

  if (cat === 'refund' && line.stripe_refund_id) {
    const r = await pool.query(
      'SELECT id, proposal_id FROM proposal_refunds WHERE stripe_refund_id = $1', [line.stripe_refund_id]);
    if (r.rows[0]) { kind = 'refund'; refundId = r.rows[0].id; proposalId = r.rows[0].proposal_id; }
  } else if (line.stripe_payment_intent_id) {
    const p = await pool.query(
      'SELECT id, proposal_id FROM proposal_payments WHERE stripe_payment_intent_id = $1',
      [line.stripe_payment_intent_id]);
    if (p.rows[0]) {
      kind = cat === 'dispute' ? 'dispute' : 'payment';
      paymentId = p.rows[0].id; proposalId = p.rows[0].proposal_id;
      const inv = await pool.query(
        'SELECT invoice_id FROM invoice_payments WHERE payment_id = $1 ORDER BY id DESC LIMIT 1', [paymentId]);
      if (inv.rows[0]) invoiceId = inv.rows[0].invoice_id;
    } else {
      const t = await pool.query('SELECT id FROM tips WHERE stripe_payment_intent_id = $1',
        [line.stripe_payment_intent_id]);
      if (t.rows[0]) { kind = cat === 'dispute' ? 'dispute' : 'tip'; tipId = t.rows[0].id; }
    }
  }
  // Fee-adjustment family: label as adjustment even when unresolvable to a proposal.
  if (kind === 'unmatched' && ['adjustment', 'other_adjustment', 'fee', 'payout_failure', 'stripe_fee'].includes(cat)) {
    kind = 'adjustment';
  }
  await pool.query(
    `UPDATE stripe_payout_lines SET matched_kind=$2, proposal_payment_id=$3, tip_id=$4,
       proposal_refund_id=$5, proposal_id=$6, invoice_id=$7, updated_at=NOW() WHERE id=$1`,
    [lineId, kind, paymentId, tipId, refundId, proposalId, invoiceId]);
}
```

- [ ] **Step 4: Run the suite**

Run: `node -r dotenv/config server/utils/stripePayoutSync.test.js`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add server/utils/stripePayoutSync.js server/utils/stripePayoutSync.test.js
git commit -m "feat(stripe-payouts): matcher — payment/tip/refund/dispute/adjustment/unmatched spine"
```

### Task 4: `sweep()` + bootstrap + atomic failed-payout alert

**Files:**
- Modify: `server/utils/stripePayoutSync.js` (replace `sweep`/`alertFailedPayout` stubs)
- Modify: `server/utils/adminNotifications.js` (add `'stripe_payout_failed'` to `VALID_CATEGORIES`)
- Test: `server/utils/stripePayoutSync.test.js` (append cases)

**Interfaces:**
- Consumes: Tasks 2-3 functions; `notifyAdminCategory({ category, subject, emailHtml, emailText })`.
- Produces: `sweep({ stripe, notify })` and `alertFailedPayout(stripePayoutId, { notify })` as declared in Task 2's contract. `notify` defaults to `notifyAdminCategory`; injectable for tests.

- [ ] **Step 1: Append failing tests**

```js
test('sweep bootstraps full history on empty table, 30-day window otherwise', async () => {
  // The fake records the params it was called with.
  let seenParams = [];
  const stripe = {
    payouts: { list: async (p) => { seenParams.push(p); return { data: [], has_more: false }; } },
    balanceTransactions: { list: async () => ({ data: [], has_more: false }) },
  };
  await sync.sweep({ stripe, notify: async () => {}, force: true });
  // Table is NOT empty here (earlier tests inserted poId), so expect created.gte:
  assert.ok(seenParams[0].created && seenParams[0].created.gte, 'expected 30-day window');
});

test('alertFailedPayout fires exactly once under concurrent callers', async () => {
  const poF = `po_test_${N}_fail`;
  await pool.query(
    `INSERT INTO stripe_payouts (stripe_payout_id, amount_cents, status, created_at_stripe, failure_message)
     VALUES ($1, 9999, 'failed', NOW(), 'account_closed')`, [poF]);
  let sends = 0;
  const notify = async () => { sends += 1; };
  await Promise.all([
    sync.alertFailedPayout(poF, { notify }),
    sync.alertFailedPayout(poF, { notify }),
    sync.alertFailedPayout(poF, { notify }),
  ]);
  assert.equal(sends, 1);
  await sync.alertFailedPayout(poF, { notify }); // later retry
  assert.equal(sends, 1);
});

test('concurrent sweeps share one in-flight run', async () => {
  let listCalls = 0;
  const stripe = {
    payouts: { list: async (p) => { listCalls += 1; await new Promise(r => setTimeout(r, 50)); return { data: [], has_more: false }; } },
    balanceTransactions: { list: async () => ({ data: [], has_more: false }) },
  };
  const o = { stripe, notify: async () => {}, force: true };
  await Promise.all([sync.sweep(o), sync.sweep(o)]);
  assert.equal(listCalls, 1);
});

test('sweep without force skips when fresh (15-minute staleness gate)', async () => {
  let listCalls = 0;
  const stripe = { payouts: { list: async () => { listCalls += 1; return { data: [], has_more: false }; } },
    balanceTransactions: { list: async () => ({ data: [], has_more: false }) } };
  const r = await sync.sweep({ stripe, notify: async () => {} }); // a forced sweep just ran above
  assert.equal(r.fresh, true);
  assert.equal(listCalls, 0);
});
```

(Empty-table bootstrap is asserted in the backfill smoke run in Task 7 — the shared dev table is non-empty by this point in the suite. Add cleanup for `poF` to `after()`.)

- [ ] **Step 2: Run to verify failure, then implement**

```js
async function alertFailedPayout(stripePayoutId, opts = {}) {
  const notify = opts.notify || notifyAdminCategory;
  // Atomic claim — never check-then-act; webhook retry, sweep, and tab-open sync race.
  const claim = await pool.query(
    `UPDATE stripe_payouts SET alerted_at = NOW()
     WHERE stripe_payout_id = $1 AND alerted_at IS NULL RETURNING id, amount_cents, failure_code, failure_message, arrival_date`,
    [stripePayoutId]);
  if (claim.rowCount !== 1) return { alreadyAlerted: true };
  const p = claim.rows[0];
  const amt = `$${(p.amount_cents / 100).toFixed(2)}`;
  try {
    await notify({
      category: 'stripe_payout_failed',
      subject: `Stripe payout FAILED: ${amt} (${p.failure_code || 'unknown'})`,
      emailText: `A Stripe payout of ${amt} to the bank account failed.\n\nReason: ${p.failure_message || p.failure_code || 'unknown'}\nPayout: ${stripePayoutId}\n\nCheck the bank account in the Stripe dashboard; Stripe pauses payouts until it is fixed.`,
      emailHtml: null, // adminNotifications falls back to text
    });
  } catch (err) {
    // Un-claim so the sweep retries the alert.
    await pool.query('UPDATE stripe_payouts SET alerted_at = NULL WHERE stripe_payout_id = $1', [stripePayoutId]);
    throw err;
  }
  return { alerted: true };
}

const STALE_MS = 15 * 60 * 1000;

async function sweep(opts = {}) {
  if (inFlight) return inFlight;
  if (!opts.force && lastSweepAt && Date.now() - new Date(lastSweepAt).getTime() < STALE_MS) {
    return { fresh: true }; // staleness gate lives here, not in the client
  }
  inFlight = (async () => {
    const stripe = client(opts);
    const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM stripe_payouts');
    const params = n === 0 ? {} // bootstrap: full history (43 payouts, one page)
      : { created: { gte: Math.floor(Date.now() / 1000) - RECHECK_DAYS * 86400 } };
    const payouts = await listAll((p) => stripe.payouts.list({ ...p, ...params }), {});
    for (const p of payouts) {
      if (p.livemode === false) continue;
      const existing = await pool.query(
        'SELECT status, lines_synced_at FROM stripe_payouts WHERE stripe_payout_id = $1', [p.id]);
      const needLines = p.status === 'paid' &&
        (!existing.rows[0] || !existing.rows[0].lines_synced_at || existing.rows[0].status !== p.status);
      if (needLines) await syncPayout(p, { stripe });
      else await upsertPayoutRow(p); // cheap status/arrival refresh, no line fetch
    }
    await syncPendingTransactions({ stripe });
    // Re-match: heals webhook-before-payment-row ordering races.
    const unmatched = await pool.query(
      `SELECT id FROM stripe_payout_lines WHERE matched_kind = 'unmatched'
       AND (stripe_payment_intent_id IS NOT NULL OR stripe_refund_id IS NOT NULL)`);
    for (const r of unmatched.rows) await matchLine(r.id);
    // Alert any failed payout not yet alerted (belt and braces for a missed webhook).
    const failed = await pool.query(
      `SELECT stripe_payout_id FROM stripe_payouts WHERE status = 'failed' AND alerted_at IS NULL`);
    for (const f of failed.rows) await alertFailedPayout(f.stripe_payout_id, opts);
    // Stuck-line signal: amber flags nobody watches need a Sentry pulse.
    const stuck = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stripe_payout_lines
       WHERE matched_kind = 'unmatched' AND payout_id IS NOT NULL AND created_at < NOW() - INTERVAL '7 days'`);
    if (stuck.rows[0].n > 0) {
      Sentry.captureMessage(`stripe-payouts: ${stuck.rows[0].n} line(s) unmatched for >7 days`, { level: 'warning' });
    }
    lastSweepAt = new Date().toISOString();
  })().finally(() => { inFlight = null; });
  return inFlight;
}
```

In `server/utils/adminNotifications.js`, add `'stripe_payout_failed'` to the `VALID_CATEGORIES` array (email-only body: callers pass no `smsBody`, matching the email-over-SMS rule).

- [ ] **Step 3: Run the suite**

Run: `node -r dotenv/config server/utils/stripePayoutSync.test.js`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add server/utils/stripePayoutSync.js server/utils/stripePayoutSync.test.js server/utils/adminNotifications.js
git commit -m "feat(stripe-payouts): sweep with bootstrap + atomic failed-payout alert + stuck-line Sentry pulse"
```

### Task 5: Webhook branches — `payout.paid` / `payout.failed`

**Files:**
- Modify: `server/routes/stripeWebhook.js` (insert the block AFTER the `charge.dispute.funds_reinstated` branch, BEFORE the final `res.json({ received: true })` at the file bottom)
- Test: `server/routes/stripeWebhook.payout.test.js`

**Interfaces:**
- Consumes: Task 2-4 module. No other branch of the webhook is touched.

- [ ] **Step 1: Write the failing webhook test**

Create `server/routes/stripeWebhook.payout.test.js` mirroring the harness in `stripeWebhook.optionGroup.test.js` verbatim (env setup, `sign()`, `postWebhook()`, express app with `express.raw` on the webhook path, router required from `./stripe`). Cases:

```js
test('payout.failed (live) upserts a failed stripe_payouts row and alerts once', async () => {
  sync._setStripeClientForTests(fakeStripe()); // no line fetch on failed
  const ev = { id: `evt_${N}_1`, type: 'payout.failed', livemode: true,
    data: { object: { id: poId, object: 'payout', amount: 5000, currency: 'usd', status: 'failed',
      created: Math.floor(Date.now()/1000), arrival_date: null, automatic: true, livemode: true,
      method: 'standard', failure_code: 'account_closed', failure_message: 'The bank account is closed.' } } };
  let res = await postWebhook(ev);
  assert.equal(res.status, 200);
  res = await postWebhook(ev); // Stripe redelivery
  assert.equal(res.status, 200);
  const rows = (await pool.query('SELECT status, alerted_at FROM stripe_payouts WHERE stripe_payout_id=$1', [poId])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'failed');
  assert.ok(rows[0].alerted_at); // claimed exactly once; SEND_NOTIFICATIONS=false no-ops the real send
});

test('payout.paid with livemode:false is acked and ignored', async () => {
  const ev = { id: `evt_${N}_2`, type: 'payout.failed', livemode: false,
    data: { object: { id: `po_tm_${N}`, object: 'payout', status: 'failed', amount: 1, created: 1, livemode: false } } };
  const res = await postWebhook(ev);
  assert.equal(res.status, 200);
  const rows = await pool.query('SELECT 1 FROM stripe_payouts WHERE stripe_payout_id=$1', [`po_tm_${N}`]);
  assert.equal(rows.rows.length, 0);
});

test('payment_intent branches unaffected: unknown event type still acks', async () => {
  const res = await postWebhook({ id: `evt_${N}_3`, type: 'payout.canceled', livemode: true,
    data: { object: { id: `po_x_${N}`, object: 'payout' } } });
  assert.equal(res.status, 200); // unhandled payout subtype falls through to the final ack
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node -r dotenv/config server/routes/stripeWebhook.payout.test.js`
Expected: FAIL (no `stripe_payouts` row created — branch missing)

- [ ] **Step 3: Add the webhook branch**

In `server/routes/stripeWebhook.js`, after the `charge.dispute.funds_reinstated` block (line ~923) and before the final `res.json({ received: true })`:

```js
  // Stripe payout tracking (read-side mirror; spec 2026-07-01). No event-level
  // dedupe here by design — idempotency is the syncPayout upsert on stripe_payout_id
  // plus the atomic alerted_at claim, matching this file's per-branch ON CONFLICT
  // convention. Test-mode events are skipped so the mirror stays live-only.
  if (event.type === 'payout.paid' || event.type === 'payout.failed') {
    if (event.livemode === false) return res.json({ received: true, skipped: 'test_mode' });
    const payout = event.data.object;
    try {
      const payoutSync = require('../utils/stripePayoutSync');
      await payoutSync.syncPayout(payout);
      if (event.type === 'payout.failed') {
        await payoutSync.alertFailedPayout(payout.id);
      }
    } catch (err) {
      // Catch-and-ack (file convention, cf. funds_reinstated): the nightly sweep
      // heals a failed sync; a 500 here would retry-storm without adding safety.
      Sentry.captureException(err, { tags: { webhook: 'stripe_payout' } });
    }
    return res.json({ received: true });
  }
```

- [ ] **Step 4: Run the payout webhook test, then the neighbor suites**

Run: `node -r dotenv/config server/routes/stripeWebhook.payout.test.js` → PASS
Run (one at a time): `node -r dotenv/config server/routes/stripe.webhook.test.js`, then `stripeWebhook.extrasLink.test.js`, `stripeWebhook.invoiceLink.test.js`, `stripeWebhook.optionGroup.test.js`, `stripeWebhook.orphanedTip.test.js`
Expected: all PASS (no interference with existing branches)

- [ ] **Step 5: Commit**

```bash
git add server/routes/stripeWebhook.js server/routes/stripeWebhook.payout.test.js
git commit -m "feat(stripe-payouts): payout.paid/payout.failed webhook branches, livemode-gated, catch-and-ack"
```

### Task 6: Routes — `/api/stripe-payouts`

**Files:**
- Create: `server/routes/stripePayouts.js`
- Modify: `server/index.js` (mount, next to the other `app.use('/api/...')` lines ~196-242: `app.use('/api/stripe-payouts', require('./routes/stripePayouts'));`)
- Test: `server/routes/stripePayouts.test.js`

**Interfaces:**
- Consumes: Tasks 1-4. `auth`, `requireAdminOrManager` from `../middleware/auth`; `adminWriteLimiter` from `../middleware/rateLimiters`; `asyncHandler` per route-file convention.
- Produces: the API contract exactly as documented at the top of this plan (the client lane builds against it).

- [ ] **Step 1: Write failing route tests**

`server/routes/stripePayouts.test.js`, following any existing admin route test's app-bootstrap pattern (e.g. `server/routes/beo.test.js`): seed one payout + two lines (one matched to the Task-3-style fixtures, one pending unmatched), then:

- no token → 401; staff-role token → 403 (mirror `auth.envelope.test.js` expectations)
- `GET /api/stripe-payouts` → `summary.in_transit_cents` equals the pending line's `net_cents`; `payouts[0].gross_cents`/`fee_cents` equal the SUMs of its lines; `unmatched_count` = 1; response contains NO Stripe call (assert the fake stripe client was never invoked: `sync._setStripeClientForTests({ get payouts() { throw new Error('GET must be DB-only'); } })`)
- `GET /api/stripe-payouts/:id` → payout + its lines with `client_name`, `invoice_number` joined
- `GET /api/stripe-payouts/999999` → 404 via `NotFoundError`
- `POST /api/stripe-payouts/sync` → 200 `{ synced: true }` (inject a no-op fake via `_setStripeClientForTests`)

- [ ] **Step 2: Implement the route file**

```js
const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { adminWriteLimiter } = require('../middleware/rateLimiters');
const asyncHandler = require('../utils/asyncHandler');
const { NotFoundError } = require('../utils/errors');
const payoutSync = require('../utils/stripePayoutSync');

const router = express.Router();

const LINE_SELECT = `
  SELECT l.id, l.stripe_balance_txn_id, l.payout_id, l.txn_type, l.reporting_category,
         l.amount_cents, l.fee_cents, l.net_cents, l.available_on, l.description,
         l.matched_kind, l.proposal_id, l.invoice_id, l.tip_id,
         c.name AS client_name, pr.event_type, pr.event_type_custom,
         inv.invoice_number, inv.token AS invoice_token,
         COALESCE(cp.preferred_name, cp.full_name) AS staff_name
  FROM stripe_payout_lines l
  LEFT JOIN proposals pr ON pr.id = l.proposal_id
  LEFT JOIN clients c ON c.id = pr.client_id
  LEFT JOIN invoices inv ON inv.id = l.invoice_id
  LEFT JOIN tips t ON t.id = l.tip_id
  LEFT JOIN contractor_profiles cp ON cp.user_id = t.target_user_id`;

// DB-only: never calls Stripe (fetched on dashboard mount for the unmatched badge).
router.get('/', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const [summary, pending, payouts] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(net_cents) FILTER (WHERE payout_id IS NULL), 0)::int AS in_transit_cents,
        COALESCE(SUM(fee_cents) FILTER (WHERE available_on >= date_trunc('month', NOW())), 0)::int AS fees_mtd_cents,
        COALESCE(SUM(fee_cents) FILTER (WHERE available_on >= date_trunc('year', NOW())), 0)::int AS fees_ytd_cents,
        COUNT(*) FILTER (WHERE matched_kind = 'unmatched')::int AS unmatched_count
      FROM stripe_payout_lines`),
    pool.query(`${LINE_SELECT} WHERE l.payout_id IS NULL ORDER BY l.available_on ASC NULLS LAST`),
    pool.query(`
      SELECT p.id, p.stripe_payout_id, p.amount_cents, p.status, p.arrival_date,
             p.created_at_stripe, p.failure_code, p.failure_message,
             COALESCE(SUM(l.amount_cents), 0)::int AS gross_cents,
             COALESCE(SUM(l.fee_cents), 0)::int AS fee_cents,
             COUNT(l.id)::int AS line_count
      FROM stripe_payouts p
      LEFT JOIN stripe_payout_lines l ON l.payout_id = p.id
      GROUP BY p.id ORDER BY p.created_at_stripe DESC`),
  ]);
  res.json({
    summary: { ...summary.rows[0], last_synced_at: payoutSync.getLastSweepAt() },
    pending: pending.rows,
    payouts: payouts.rows,
  });
}));

router.get('/:id(\\d+)', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const p = await pool.query(`
    SELECT p.*, COALESCE(SUM(l.amount_cents),0)::int AS gross_cents,
           COALESCE(SUM(l.fee_cents),0)::int AS fee_cents, COUNT(l.id)::int AS line_count
    FROM stripe_payouts p LEFT JOIN stripe_payout_lines l ON l.payout_id = p.id
    WHERE p.id = $1 GROUP BY p.id`, [req.params.id]);
  if (!p.rows[0]) throw new NotFoundError('Payout not found');
  const lines = await pool.query(`${LINE_SELECT} WHERE l.payout_id = $1 ORDER BY l.amount_cents DESC`, [req.params.id]);
  res.json({ payout: p.rows[0], lines: lines.rows });
}));

router.post('/sync', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  // In-flight guard + 15-min staleness gate live in the module; force bypasses staleness only.
  const r = await payoutSync.sweep({ force: req.body?.force === true });
  res.json({ synced: !(r && r.fresh), last_synced_at: payoutSync.getLastSweepAt() });
}));

module.exports = router;
```

(Check `asyncHandler`'s actual export path/name against a neighbor route file before writing; some files destructure it from `../utils/errors`.)

- [ ] **Step 3: Mount in `server/index.js`, run the route tests**

Run: `node -r dotenv/config server/routes/stripePayouts.test.js`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add server/routes/stripePayouts.js server/routes/stripePayouts.test.js server/index.js
git commit -m "feat(stripe-payouts): admin routes — DB-only GET list/detail + rate-limited sync"
```

### Task 7: Scheduler + backfill script + env

**Files:**
- Modify: `server/index.js` (scheduler block), `.env.example`
- Create: `server/scripts/backfillStripePayouts.js`

**Interfaces:**
- Consumes: `sweep()`; `wrapScheduler`/`clearHealthRow` pattern from `server/utils/schedulerHealth` exactly as the existing blocks at `server/index.js:333-410`.

- [ ] **Step 1: Register the nightly sweep**

After the pending-email-cleanup block in `server/index.js` (~line 409), matching the existing pattern:

```js
      // Stripe payout sweep — daily mirror heal (webhook misses, pending bucket, re-match)
      if (enabled('RUN_STRIPE_PAYOUT_SWEEP_SCHEDULER')) {
        const { sweep } = require('./utils/stripePayoutSync');
        const wrapped = wrapScheduler('stripe_payout_sweep', 86400, sweep);
        setTimeout(wrapped, 240000);
        setInterval(wrapped, 24 * 60 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('stripe_payout_sweep');
      }
```

- [ ] **Step 2: Backfill script**

`server/scripts/backfillStripePayouts.js`:

```js
#!/usr/bin/env node
// One-off backfill: full Stripe payout history into the read-side mirror.
// Safe to re-run (idempotent upserts). Refuses to run in test mode.
require('dotenv').config();
const { sweep } = require('../utils/stripePayoutSync');
const { pool } = require('../db');

(async () => {
  const until = process.env.STRIPE_TEST_MODE_UNTIL;
  if (until && new Date(until) > new Date()) {
    console.error('STRIPE_TEST_MODE_UNTIL is active — backfill must run against live. Aborting.');
    process.exit(1);
  }
  await sweep(); // empty-table bootstrap fetches full history
  const p = await pool.query('SELECT COUNT(*)::int n FROM stripe_payouts');
  const l = await pool.query(`SELECT matched_kind, COUNT(*)::int n FROM stripe_payout_lines GROUP BY matched_kind ORDER BY n DESC`);
  console.log(`payouts: ${p.rows[0].n}`);
  console.table(l.rows);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: `.env.example`** — add under the scheduler flags block:

```
# Set to false to disable the daily Stripe payout mirror sweep. Default on (prod only, like all schedulers).
RUN_STRIPE_PAYOUT_SWEEP_SCHEDULER=
```

- [ ] **Step 4: Dev smoke — run the backfill against the DEV database with the live Stripe key**

Run: `node server/scripts/backfillStripePayouts.js`
Expected: `payouts: 43` (and a matched_kind table; on the dev DB most lines will be `unmatched` because dev's proposal_payments differ from prod — that is expected and fine; the REAL matching verification happens at the prod backfill, rollout step 3).

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/scripts/backfillStripePayouts.js .env.example
git commit -m "feat(stripe-payouts): nightly sweep scheduler + live-mode-asserting backfill script"
```

### Task 8: Docs (mandatory-docs table)

**Files:**
- Modify: `README.md` (folder tree: the 4 new server files + StripePayoutsTab.js; env table: `RUN_STRIPE_PAYOUT_SWEEP_SCHEDULER`; Key Features: one line "Stripe payout tracking — bank-level reconciliation tab in Financials")
- Modify: `ARCHITECTURE.md` (API route table: the 3 endpoints; Database Schema: both tables; Third-Party Integrations: note payout mirror under Stripe)
- Modify: `.claude/CLAUDE.md` (env table row for `RUN_STRIPE_PAYOUT_SWEEP_SCHEDULER`, same wording as the other `RUN_*_SCHEDULER` rows)

- [ ] **Step 1: Make the three doc edits, commit**

```bash
git add README.md ARCHITECTURE.md .claude/CLAUDE.md
git commit -m "docs(stripe-payouts): README/ARCHITECTURE/CLAUDE.md entries per mandatory-docs table"
```

---

# Lane: stripe-payouts-client

### Task C1: `StripePayoutsTab` component

**Files:**
- Create: `client/src/pages/admin/StripePayoutsTab.js`

**Interfaces:**
- Consumes: the API contract above via `client/src/utils/api.js`; `StatusChip`, `fmt$fromCents`, `fmtDate` from `components/adminos`; `useToast`.
- Produces: `export default function StripePayoutsTab()` — self-contained; parent only mounts it.

- [ ] **Step 1: Implement the component**

```jsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import StatusChip from '../../components/adminos/StatusChip';
import { fmt$fromCents, fmtDate } from '../../components/adminos/format';
import { getEventTypeLabel } from '../../utils/eventTypes';

const PAYOUT_STATUS = { paid: 'ok', in_transit: 'info', pending: 'info', canceled: 'neutral', failed: 'danger' };
const KIND = { payment: 'ok', tip: 'accent', refund: 'warn', dispute: 'danger', adjustment: 'neutral', unmatched: 'warn' };

function lineLabel(l) {
  if (l.matched_kind === 'tip') return `Gratuity: ${l.staff_name || 'staff'}`;
  if (l.client_name) {
    const ev = getEventTypeLabel({ event_type: l.event_type, event_type_custom: l.event_type_custom });
    return `${l.client_name} (${ev}${l.invoice_number ? `, ${l.invoice_number}` : ''})`;
  }
  return l.description || l.stripe_balance_txn_id;
}

export default function StripePayoutsTab() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState(null); // payout id
  const [lines, setLines] = useState({});         // payout id -> lines[]
  const syncedOnce = useRef(false);

  const load = useCallback(() =>
    api.get('/stripe-payouts')
      .then(r => { setData(r.data); return r.data; })
      .catch(err => { toast.error(err.message || 'Could not load Stripe payouts. Try refreshing.'); return null; })
      .finally(() => setLoading(false)), [toast]);

  const syncNow = useCallback((force) => {
    setSyncing(true);
    return api.post('/stripe-payouts/sync', force ? { force: true } : {})
      .then(r => { if (r.data?.synced) return load(); })
      .catch(err => toast.error(err.message || 'Sync failed. Try again in a minute.'))
      .finally(() => setSyncing(false));
  }, [load, toast]);

  useEffect(() => {
    // Stale-then-refresh: render DB data immediately; the server's 15-minute
    // staleness gate decides whether the background sync actually runs.
    load().then(d => {
      if (syncedOnce.current || !d) return;
      syncedOnce.current = true;
      syncNow(false);
    });
  }, [load, syncNow]);

  const toggle = (id) => {
    if (expanded === id) return setExpanded(null);
    setExpanded(id);
    if (!lines[id]) {
      api.get(`/stripe-payouts/${id}`)
        .then(r => setLines(prev => ({ ...prev, [id]: r.data.lines })))
        .catch(err => toast.error(err.message || 'Could not load payout detail.'));
    }
  };

  if (loading) return <div className="muted">Loading…</div>;
  if (!data) return <div className="chip danger">Couldn't load Stripe payouts. Try refreshing.</div>;
  const s = data.summary || {};

  return (
    <>
      <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
        <div className="stat">
          <div className="stat-label">In transit</div>
          <div className="stat-value">{fmt$fromCents(s.in_transit_cents || 0)}</div>
          <div className="stat-sub"><span>{(data.pending || []).length} settled charge{(data.pending || []).length === 1 ? '' : 's'} awaiting payout</span></div>
        </div>
        <div className="stat">
          <div className="stat-label">Stripe fees (month)</div>
          <div className="stat-value">{fmt$fromCents(s.fees_mtd_cents || 0)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Stripe fees (YTD)</div>
          <div className="stat-value">{fmt$fromCents(s.fees_ytd_cents || 0)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Last synced</div>
          <div className="stat-value" style={{ fontSize: '1rem' }}>
            {syncing ? 'Syncing…' : (s.last_synced_at ? fmtDate(String(s.last_synced_at).slice(0, 10), { year: 'numeric' }) : 'server restart')}
          </div>
          <div className="stat-sub">
            <button className="btn btn-secondary btn-sm" onClick={() => syncNow(true)} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
        </div>
      </div>

      {(data.pending || []).length > 0 && (
        <div className="card" style={{ marginBottom: 'var(--gap)', overflow: 'hidden' }}>
          <div className="card-head"><h3>In transit</h3><span className="k">{data.pending.length}</span></div>
          <div className="tbl-wrap"><table className="tbl">
            <thead><tr><th>What</th><th>Type</th><th className="num">Gross</th><th className="num">Fee</th><th className="num">Net</th><th>Est. payout</th></tr></thead>
            <tbody>{data.pending.map(l => (
              <tr key={l.id}>
                <td><strong>{lineLabel(l)}</strong></td>
                <td><StatusChip kind={KIND[l.matched_kind] || 'neutral'}>{l.matched_kind}</StatusChip></td>
                <td className="num">{fmt$fromCents(l.amount_cents)}</td>
                <td className="num muted">{fmt$fromCents(l.fee_cents)}</td>
                <td className="num">{fmt$fromCents(l.net_cents)}</td>
                <td className="muted">{l.available_on ? fmtDate(String(l.available_on).slice(0, 10), { year: 'numeric' }) : '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head"><h3>Payouts</h3><span className="k">{(data.payouts || []).length}</span></div>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>Arrived</th><th>Status</th><th className="num">Gross</th><th className="num">Fees</th><th className="num">Net to bank</th><th className="num">Lines</th></tr></thead>
          <tbody>
            {(data.payouts || []).length === 0 && (
              <tr><td colSpan={6} className="muted">No payouts synced yet. Hit Sync now.</td></tr>
            )}
            {(data.payouts || []).map(p => (
              <React.Fragment key={p.id}>
                <tr onClick={() => toggle(p.id)} style={{ cursor: 'pointer' }} title="Show what made up this payout">
                  <td><strong>{p.arrival_date ? fmtDate(String(p.arrival_date).slice(0, 10), { year: 'numeric' }) : '—'}</strong></td>
                  <td>
                    <StatusChip kind={PAYOUT_STATUS[p.status] || 'neutral'}>{p.status.replace('_', ' ')}</StatusChip>
                    {p.failure_message && <span className="muted" style={{ display: 'block', fontSize: '0.85em' }}>{p.failure_message}</span>}
                  </td>
                  <td className="num">{fmt$fromCents(p.gross_cents)}</td>
                  <td className="num muted">{fmt$fromCents(p.fee_cents)}</td>
                  <td className="num"><strong>{fmt$fromCents(p.amount_cents)}</strong></td>
                  <td className="num muted">{p.line_count}</td>
                </tr>
                {expanded === p.id && (lines[p.id] || []).map(l => (
                  <tr key={l.id} style={{ background: 'var(--paper-2, transparent)' }}>
                    <td className="muted" style={{ paddingLeft: '2em' }}>{lineLabel(l)}</td>
                    <td><StatusChip kind={KIND[l.matched_kind] || 'neutral'}>{l.matched_kind}</StatusChip></td>
                    <td className="num">{fmt$fromCents(l.amount_cents)}</td>
                    <td className="num muted">{fmt$fromCents(l.fee_cents)}</td>
                    <td className="num">{fmt$fromCents(l.net_cents)}</td>
                    <td />
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table></div>
      </div>
    </>
  );
}
```

Style notes for the implementer: reuse existing classes only (`stat-row`, `card`, `tbl`, `chip`, `btn`); no new CSS unless a gap is real, and then in `index.css` per convention. Proposal links: `lineLabel` rows with `l.proposal_id` may wrap in a react-router `Link` to `/proposals/${l.proposal_id}` if it reads cleanly; otherwise leave plain text (v1 does not require navigation).

### Task C2: FinancialsDashboard tab toggle + NotificationSettings label

**Files:**
- Modify: `client/src/pages/admin/FinancialsDashboard.js`
- Modify: `client/src/pages/admin/NotificationSettings.js`

- [ ] **Step 1: Add the tab toggle**

In `FinancialsDashboard.js`: add `const [tab, setTab] = useState('overview');` and fetch the payout summary once on mount for the badge (DB-only endpoint, safe):

```jsx
const [payoutBadge, setPayoutBadge] = useState(0);
useEffect(() => {
  api.get('/stripe-payouts')
    .then(r => setPayoutBadge(r.data?.summary?.unmatched_count || 0))
    .catch(() => {}); // badge is best-effort; the tab itself surfaces errors
}, []);
```

Insert the toggle between the page header and `<MetricsFilterBar>`; move the ENTIRE existing body (filter bar + stat row + both cards) inside `{tab === 'overview' && (...)}`, and render the new tab in the other branch:

```jsx
<div style={{ display: 'flex', gap: '0.5rem', marginBottom: 'var(--gap)' }}>
  <button className={`btn btn-sm ${tab === 'overview' ? 'btn-primary' : 'btn-secondary'}`}
    onClick={() => setTab('overview')}>Overview</button>
  <button className={`btn btn-sm ${tab === 'payouts' ? 'btn-primary' : 'btn-secondary'}`}
    onClick={() => setTab('payouts')}>
    Stripe Payouts{payoutBadge > 0 ? ` (${payoutBadge} unmatched)` : ''}
  </button>
</div>
{tab === 'overview' && ( /* existing MetricsFilterBar + body, unchanged */ )}
{tab === 'payouts' && <StripePayoutsTab />}
```

The MetricsFilterBar lives INSIDE the overview branch (payouts are Stripe-native; the proposal-basis filters do not apply). `useMetricsFilter` stays at component top level, so filter state survives tab toggles. IMPORTANT: this file was just touched by the tt-lead-spend lane; re-read it at build time and place the toggle around the CURRENT body, whatever it holds by then.

- [ ] **Step 2: NotificationSettings label**

In `client/src/pages/admin/NotificationSettings.js`, add to `CATEGORY_LABELS`:

```js
stripe_payout_failed: 'Stripe payout failures',
```

Check step: `grep -n "VALID_CATEGORIES\|categories" server/routes/me.js` — if the notification-prefs endpoint enumerates categories from a hardcoded list rather than `adminNotifications.VALID_CATEGORIES`, add the new key there too (server lane owns me.js; coordinate via the lane merge if needed — expected outcome is that it imports VALID_CATEGORIES and no change is needed).

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/admin/StripePayoutsTab.js client/src/pages/admin/FinancialsDashboard.js client/src/pages/admin/NotificationSettings.js
git commit -m "feat(stripe-payouts): Stripe Payouts tab on Financials — in-transit bucket, fee rollups, payout drill-down"
```

### Task C3: CI build gate

- [ ] **Step 1: Run the exact Vercel build**

Run: `cd client && CI=true npx react-scripts build`
Expected: compiles with zero warnings (CI treats warnings as errors). Fix any ESLint findings before the lane is done.

---

# Merge, push, go-live

1. **Gate check:** confirm `git log origin/main..main` no longer contains other windows' unpushed work mid-flight on stripeWebhook.js (proposal-options client-admin etc. pushed).
2. Merge `stripe-payouts-server` first (full fleet: code + security + database + performance + consistency, max effort). Then `stripe-payouts-client` (code review + UI look; CI build). Push both in ONE batch (the client tab 404s without the server routes).
3. Prod schema applies on boot (initDb). Verify via Neon MCP: `SELECT to_regclass('stripe_payouts')` on the production branch.
4. Run the backfill against prod: from the repo with prod `DATABASE_URL` exported for the single command (handle the string carefully, never commit it):
   `DATABASE_URL='<prod>' node server/scripts/backfillStripePayouts.js`
   Expected: `payouts: 43+`, matched table dominated by `payment`/`tip`, `unmatched` at or near zero. Investigate ANY unmatched line now, while the history is small.
5. Stripe dashboard → the prod webhook endpoint → add `payout.paid` and `payout.failed` to enabled events.
6. Open Financials → Stripe Payouts, compare the payout list line-for-line against the Stripe dashboard payouts page (same count, same amounts, same dates).
7. Next business day: confirm the daily payout landed via webhook (new `stripe_payouts` row with `lines_synced_at` set, no sweep needed).

**Failure modes to watch at go-live:** step 4 aborting on `STRIPE_TEST_MODE_UNTIL` (unset it or wait it out); `fees_mtd_cents` including fees from pending lines (correct by design — fees accrue when the charge settles, not when paid out).
