# Stripe Payout Tracking in Financials

**Date:** 2026-07-01
**Status:** Approved (brainstorm section approvals 2026-07-01). Spec fleet reviewed
2026-07-01: 2 blockers, 10 warnings, 6 suggestions; all folded in except the
category-reuse suggestion (dedicated `stripe_payout_failed` category kept).
**Difficulty:** Large. Money-adjacent everywhere: new schema, stripeWebhook.js, Stripe API, reconciliation, UI.

## 1. Goal

Track when money actually lands in the bank: which Stripe payout it rode, and which
events, invoices, payments, tips, refunds, and disputes make up each payout. Includes
estimated dates for money still in transit, gross/fee/net visibility, and a
failed-payout alert. Bank-level reconciliation, the successor to the
payment-accounting-fixes project.

This subsystem is a **read-side mirror of Stripe**. It never mutates proposals,
proposal_payments, invoices, tips, or any existing money table. Worst case is a wrong
report, never wrong money.

## 2. Verified grounding (checked against live systems 2026-07-01)

- Account `acct_1QoT0FAZrfv5tWfN` pays out **daily, automatically, 2-day rolling
  delay**, standard bank transfers. 43 payouts in the account's life (earliest
  2025-02-11), all status `paid`, none failed. Balance at check time: $630.55 pending,
  $0 available.
- Payout anatomy (verified on po_1Tnpi3AZrfv5tWfNdNwOthXc, $533.45, 6/30): listing
  balance transactions with `payout=po_...` returns the payout's own negative
  `type=payout` row plus one row per constituent transaction, each carrying signed
  amount/fee/net (integer cents), `available_on`, `reporting_category`, a
  human-readable description ("INV-0091 — Allyson Gietl"), and a source charge whose
  `payment_intent` is expandable.
- Estimated dates come straight from Stripe fields: `payout.arrival_date` for created
  payouts, `balance_transaction.available_on` for pending funds. No heuristic.
- Prod linkage coverage: 36 `proposal_payments` rows, 32 with a `pi_` id. The 4
  without (ids 12, 28, 283, 284) are manually recorded non-Stripe payments; they have
  no Stripe presence and are **excluded** from matching by design, not "unmatched".
- `tips.stripe_payment_intent_id` is `TEXT UNIQUE NOT NULL`, so gratuity charges
  reconcile through the same spine. `proposal_refunds` carries `stripe_refund_id`.
- `stripeWebhook.js` (928 lines) handles 6 event types today, none payout-related.
  Signature verification (live + test secrets) exists at the top of the file. There
  is NO event-level dedupe in that file: the `webhook_events` table belongs to the
  Cal.com webhook (`calcom.js`), and stripeWebhook.js idempotency is per-branch
  ON CONFLICT keyed on Stripe ids (see the comment near line 895). Payout branches
  therefore bring their own idempotency (section 5).
- No payout/settlement table, no `payouts.list` or `balance_transactions` call exists
  anywhere in server/ today.

## 3. Vocabulary and invariants

- **Naming trap:** "payouts" in this codebase means staff payroll (`payouts`,
  `payout_events` tables; PayoutsTab.js etc.). This subsystem uses the `stripe_`
  prefix everywhere: `stripe_payouts`, `stripe_payout_lines`,
  `server/routes/stripePayouts.js`, `server/utils/stripePayoutSync.js`,
  StripePayoutsTab.js. UI copy says "Stripe Payouts".
- **Cents-native end to end.** All amounts integer cents (matches Stripe, invoices,
  payments, refunds). Display formatting converts at the edge. Proposals dollars are
  never mixed in.
- **Stripe access only via `server/utils/stripeClient.js`** (never
  `require('stripe')` directly; honors STRIPE_TEST_MODE_UNTIL, fails closed).
- **Read-side only.** No writes to any existing table. New tables only.
- **Idempotent everywhere.** All ingest paths converge on upserts keyed on Stripe ids
  (`po_`, `txn_`), so webhook, sweep, backfill, and view-refresh can overlap safely.

## 4. Data model

Two new tables in `server/db/schema.sql`, idempotent DDL per file convention
(CREATE TABLE IF NOT EXISTS; initDb applies on prod boot; apply to the dev DB by hand,
schema.sql is not auto-applied to dev).

```sql
CREATE TABLE IF NOT EXISTS stripe_payouts (
  id SERIAL PRIMARY KEY,
  stripe_payout_id TEXT UNIQUE NOT NULL,          -- po_...
  amount_cents INTEGER NOT NULL,                  -- net amount that lands in bank
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL,                           -- paid | in_transit | pending | canceled | failed
  created_at_stripe TIMESTAMPTZ NOT NULL,         -- payout creation time at Stripe
  arrival_date DATE,                              -- Stripe's arrival estimate/actual
  automatic BOOLEAN NOT NULL DEFAULT true,
  livemode BOOLEAN NOT NULL DEFAULT true,         -- ingest skips non-live objects; column is the tripwire
  method TEXT,                                    -- standard | instant
  description TEXT,
  failure_code TEXT,
  failure_message TEXT,
  alerted_at TIMESTAMPTZ,                         -- failed-payout alert sent (gate: alert fires once)
  lines_synced_at TIMESTAMPTZ,                    -- NULL until balance txns fetched; sweep heals NULLs
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stripe_payout_lines (
  id SERIAL PRIMARY KEY,
  stripe_balance_txn_id TEXT UNIQUE NOT NULL,     -- txn_...
  payout_id INTEGER REFERENCES stripe_payouts(id) ON DELETE CASCADE,  -- NULL = pending (in transit)
  txn_type TEXT NOT NULL,                         -- Stripe balance_transaction.type
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
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL,   -- denormalized for display
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stripe_payout_lines_payout ON stripe_payout_lines(payout_id);
CREATE INDEX IF NOT EXISTS idx_stripe_payout_lines_pi ON stripe_payout_lines(stripe_payment_intent_id);
```

Design notes:

- **Nullable `payout_id` is the pending bucket.** A settled charge not yet in a payout
  is a line with `payout_id NULL`. When its payout arrives, the by-payout fetch claims
  it (upsert on `stripe_balance_txn_id` sets `payout_id`). "In transit" is
  `WHERE payout_id IS NULL AND txn_type <> 'payout'`. No separate state machine.
- Gross and total fees per payout are **not stored**: they are SUMs over lines at read
  time, so nothing drifts. `stripe_payouts.amount_cents` is Stripe's net.
- The payout's own negative `type=payout` balance transaction is skipped at ingest.
- `proposal_payments.fee_cents` exists (written by the gratuity flow) but this feature
  does not depend on it or write it; line fees come from balance transactions.

## 5. Ingestion

One shared module, `server/utils/stripePayoutSync.js`, exposing:

- `syncPayout(payoutOrId)`: upsert the `stripe_payouts` row; list its balance
  transactions (paginated, `expand[]=data.source`); upsert lines (claiming pending
  ones); run the matcher on each; set `lines_synced_at` on success.
- `syncPendingTransactions()`: list balance transactions from the last 30 days
  (covers status pending and available; ample at this volume given the 2-day delay),
  paginated like every other list call; insert any non-payout transaction not yet
  stored as a line with `payout_id NULL`, strictly `ON CONFLICT DO NOTHING`.
  **Ownership rule: only `syncPayout` ever sets or changes `payout_id`.** The
  pending path never updates an existing line; a naive upsert here would un-claim
  lines from a paid payout and flip settled money back to "in transit".
- `matchLine(line)`: the matcher (section 6).
- `sweep()`: list payouts created in the last 30 days (a fixed re-check window that
  comfortably exceeds the 2-day pending-to-terminal horizon and heals missed or
  status-changed payouts). When the `stripe_payouts` table is EMPTY, bootstrap by
  listing full account history instead (43 payouts, one page); this makes the
  backfill script a thin wrapper around `sweep()`. `syncPayout` any payout that is
  new, status-changed, or has `lines_synced_at IS NULL`; `syncPendingTransactions()`;
  re-run the matcher on `matched_kind='unmatched'` lines; alert on any `failed`
  payout not yet alerted (atomic claim, see the alert paragraph below).

Three callers plus a view refresh, all through this module, all idempotent:

1. **Webhook.** Add `payout.paid` and `payout.failed` branches to
   `server/routes/stripeWebhook.js`, behind the existing signature verification.
   There is no event-level dedupe in this file to inherit; payout idempotency
   follows the file's actual convention, per-branch ON CONFLICT keyed on Stripe
   ids. Concretely: `payout.paid` calls `syncPayout(event.data.object)`, idempotent
   via the upsert on `stripe_payout_id` (a Stripe retry re-runs the same upserts to
   the same state); `payout.failed` upserts status/failure fields and sends the
   admin alert behind the atomic `alerted_at` claim (below). Payout branches skip
   objects with `livemode: false` (section 9). Go-live config: add `payout.paid`
   and `payout.failed` to the webhook endpoint's enabled events in the Stripe
   dashboard (config step, not code).
2. **Nightly sweep.** Register `sweep()` in `server/index.js` using the existing
   schedulerHealth-wrapped `setInterval` pattern (24h interval, same as the existing
   daily jobs), with a per-scheduler disable flag `RUN_STRIPE_PAYOUT_SWEEP_SCHEDULER`
   matching the convention (documented in the CLAUDE.md and README env tables). The
   sweep is the heal for missed webhooks and the belt-and-braces failed-payout
   detector.
3. **Backfill.** One-off `server/scripts/backfillStripePayouts.js`: asserts live
   mode (refuses to run while `STRIPE_TEST_MODE_UNTIL` is active), then runs
   `sweep()`, whose empty-table bootstrap fetches full account history (43 payouts,
   one API page). Safe to re-run.
4. **View refresh.** Opening the tab calls `POST /api/stripe-payouts/sync` when the
   last sync was more than 15 minutes ago. Staleness and concurrency both live in
   the sync module as module-level state: a `lastSweepAt` timestamp plus a shared
   in-flight promise, so concurrent callers (two admins, a double-click) await the
   same sweep instead of stacking Stripe calls. A process restart just means one
   extra sweep, which is data-safe. The endpoint runs `sweep()`, cheap at this
   volume, so both the pending bucket and the payout list are current when viewed.
   One refresh path, not two.

**Failed-payout alert:** `notifyAdminCategory` in `server/utils/adminNotifications.js`
with a new category `stripe_payout_failed` added to VALID_CATEGORIES, email-only body
(no smsBody, per the email-over-SMS cost rule). Fired by the webhook handler and by
the sweep for any failed payout not yet alerted. The fires-once gate is an ATOMIC
CLAIM, never check-then-act (webhook retry, nightly sweep, and tab-open sync can
race):

```sql
UPDATE stripe_payouts SET alerted_at = NOW()
WHERE stripe_payout_id = $1 AND alerted_at IS NULL RETURNING id
```

Send only when `rowCount === 1`. Client cross-cutting: the new category also needs
its entry in CATEGORY_LABELS in `client/src/pages/admin/NotificationSettings.js`
(the toggle renders unlabeled otherwise); confirm the notification-prefs endpoint
in `server/routes/me.js` enumerates it. `resolveCategoryRecipients` defaults unset
prefs to on (COALESCE), so no data migration is needed.

## 6. Matching (the reconciliation spine)

Per line, in order:

1. `reporting_category='charge'` (or `txn_type='charge'/'payment'`): source charge's
   `payment_intent` id looked up in `proposal_payments.stripe_payment_intent_id`
   (sets `matched_kind='payment'`, `proposal_payment_id`, `proposal_id`, and
   `invoice_id` via `invoice_payments` when the payment is invoice-linked), else in
   `tips.stripe_payment_intent_id` (sets `matched_kind='tip'`, `tip_id`).
2. `reporting_category='refund'`: `stripe_refund_id` looked up in
   `proposal_refunds.stripe_refund_id` (sets `matched_kind='refund'`,
   `proposal_refund_id`, and `proposal_id` straight from the refund row's own
   NOT NULL `proposal_id` FK).
3. `reporting_category='dispute'` (funds withdrawn or reinstated): resolve via the
   dispute's charge back to the payment/tip, `matched_kind='dispute'`.
4. Stripe fee adjustments and similar (`txn_type='adjustment'` etc.): resolve via
   source charge where possible, `matched_kind='adjustment'`.
5. Anything unresolved stays `matched_kind='unmatched'` and **visible** in the UI.
   Never silently dropped. The sweep retries unmatched lines nightly (heals webhook
   ordering races where the payout landed before the payment row).

Manual non-Stripe payments (the 4 prod rows and future ones) never enter this system:
they have no balance transactions. The tab is Stripe-only, by design. Do not "fix"
their absence.

## 7. API

New route file `server/routes/stripePayouts.js`, mounted at `/api/stripe-payouts` in
`server/index.js`. All routes gated `auth, requireAdminOrManager` (same as
`GET /api/proposals/financials`). Integer `:id` params (no UUID token guard needed).

- `GET /api/stripe-payouts`: DB-only, never calls Stripe (safe to fetch on
  dashboard mount for the unmatched badge). Returns the payout list (paged if ever
  needed; 43 rows today), each with computed gross/fee/net (SUM over lines) and
  line count; the pending bucket (lines with `payout_id NULL`, each with
  `available_on` as the estimated payout date); summary rollups (in-transit total,
  Stripe fees MTD and YTD, unmatched count).
- `GET /api/stripe-payouts/:id`: one payout plus its lines joined to display info
  (client/event name via proposal, invoice number, tip staff name, type badge data).
- `POST /api/stripe-payouts/sync`: runs `sweep()` through the module's shared
  in-flight guard, behind `adminWriteLimiter`
  (`server/middleware/rateLimiters.js`), so a held button or several managers
  cannot stack Stripe calls. Backs the manual "Sync now" button and the 15-minute
  staleness refresh on tab open.

## 8. UI

`StripePayoutsTab` inside `client/src/pages/admin/FinancialsDashboard.js`.
FinancialsDashboard has no tab structure today (175 lines): introduce a simple
two-tab toggle (Overview | Stripe Payouts) following the existing admin tab pattern
(cf. the payroll dashboard's tabs), existing apothecary tokens, no new design system.

- **Summary chips:** In transit now (with nearest estimated landing date), Stripe
  fees this month, Stripe fees YTD.
- **Pending section:** settled-but-not-paid-out lines with estimated payout date
  (`available_on`; note that the daily schedule means landing is typically the same
  or next business day after it becomes available).
- **Payout list:** date, arrival date, status chip, gross / fee / net, line count.
  Expand (or drill in) to lines: description, event/client link, invoice link, type
  badge (payment / tip / refund / dispute / adjustment / unmatched), signed amounts.
- **Unmatched flag:** amber flag on unmatched lines; count badge on the tab toggle
  when any exist, fed by the DB-only GET fetched on dashboard mount (no Stripe call
  from the Overview tab). Empty-or-near-empty is the expected healthy state.
- Failed payouts render with a red status chip and the failure message.
- **Filter bar:** the existing MetricsFilterBar / useMetricsFilter controls
  (date-range, basis, include-cc) apply to the Overview tab only and are hidden on
  the Stripe Payouts tab; payouts are Stripe-native and ignore proposal-basis
  filters. Filter state is preserved across the tab toggle.
- **Sync states:** on tab open, render current DB data immediately, kick the
  staleness sync in the background with a subtle "Syncing" indicator, and refetch
  when it completes (stale-then-refresh, no blocking spinner). Sync or fetch
  failures follow the dashboard's existing toast + danger-chip error pattern, with
  retry via "Sync now". The "Sync now" button disables while a sync is in flight
  (the server's in-flight guard is the backstop).
- Client CI gate applies: verify with `CI=true react-scripts build`.

## 9. Edge handling

- **Partial sync failure:** if the line fetch fails mid-payout, `lines_synced_at`
  stays NULL and the nightly sweep retries. A thrown error in a payout branch is
  captured to Sentry; because every ingest step is an idempotent upsert, either a
  Stripe webhook retry or the sweep completes the sync. Payout branches never
  interfere with the payment-intent branches.
- **Webhook ordering:** a payout webhook can arrive before the app records a payment
  row (rare; payments are recorded at charge time, payouts 2+ days later). Lines
  land `unmatched` and the sweep re-matches nightly.
- **Pagination:** balance transactions per payout paginated properly
  (`starting_after`), even though current volumes fit one page.
- **Instant/manual payouts:** none exist on this account (all automatic standard),
  but `automatic` and `method` are stored so nothing breaks if one appears.
- **Test mode / livemode:** all calls ride `stripeClient.js` fail-closed behavior.
  Ingest records `livemode` from the Stripe object and SKIPS non-live objects, so a
  test-mode event or a sweep run under `STRIPE_TEST_MODE_UNTIL` cannot pollute the
  mirror; the backfill script asserts live mode outright. In dev with a test key
  the tab simply renders empty states.
- **Observability:** Sentry capture on any `syncPayout`/`sweep` throw, plus a
  warn-level Sentry capture when the sweep finds lines still unmatched after 7
  days, so a stuck line has a signal beyond the amber UI flag.
- **Currency:** account is USD-only; `currency` stored, no multi-currency logic.

## 10. Explicitly out of scope

- CheckCherry-era charges (different Stripe account DRB does not control).
- Any write-back to existing tables (including backfilling
  `proposal_payments.fee_cents` on old rows).
- CSV export / statement PDFs (easy later bolt-on if the accountant asks).
- Changing gratuity fee-netting or payrollAccrual in any way. The tab makes Stripe
  fees visible; the "100% to your staff" framing and fee-netting behavior are
  accepted and untouched.
- SMS alerts (email only).
- Webhook `payout.created`/`payout.updated` handling (the sweep plus `payout.paid`
  cover reality on a daily-automatic account; add later only if a need appears).

## 11. Testing

node:test suites (run per-suite in isolation per the shared-dev-DB rule, with
`node -r dotenv/config` where the suite touches env):

- `stripePayoutSync.test.js` with a stubbed stripeClient: upsert idempotency
  (webhook + sweep double-run yields identical rows), pending-line claim by a later
  payout, pending path never un-claims or updates an existing line, every matcher
  path (payment, tip, invoice-linked payment, refund, dispute, adjustment,
  unmatched), skip of the payout's own txn and of `livemode: false` objects,
  empty-table bootstrap fetches full history, partial-failure heal
  (`lines_synced_at` NULL then sweep retry), failed-payout alert fires exactly once
  under concurrent callers (atomic `alerted_at` claim), backfill re-run safety.
- Webhook branch tests following the existing stripeWebhook test conventions:
  signature-verified `payout.paid`/`payout.failed` events route to the sync module,
  replay converges to identical state (upsert idempotency, single alert), test-mode
  events skipped, no interference with payment_intent handlers.
- Route tests: auth gating, rollup math (gross/fee/net sums, MTD/YTD fees), pending
  bucket query.
- Manual verification: run backfill against prod (read-only Stripe calls, writes only
  to the two new tables), then compare the tab's payout list and totals line-by-line
  against the Stripe dashboard payouts page.

## 12. Rollout

1. Merge schema + server + client (single lane, full fleet review: money + webhook
   surfaces at max effort). The same change updates docs per the mandatory table:
   README.md (folder tree, env vars, key features), ARCHITECTURE.md (route table,
   database schema, integrations), CLAUDE.md + README env tables
   (`RUN_STRIPE_PAYOUT_SWEEP_SCHEDULER`), and `.env.example`.
2. Apply the two new tables to the dev DB by hand (schema.sql is not auto-applied to
   dev); prod gets them on boot via initDb.
3. Deploy. Run `server/scripts/backfillStripePayouts.js` once against prod.
4. Stripe dashboard: add `payout.paid` and `payout.failed` to the webhook endpoint's
   enabled events.
5. Verify the next daily payout lands via webhook (webhook_events row + new
   stripe_payouts row) and matches the Stripe dashboard.

**Sequencing:** the build lane must wait until the proposal-options windows finish
pushing (their client-side commits are merged but unpushed as of this writing;
stripeWebhook.js lane work has landed). Plan-only until then.
