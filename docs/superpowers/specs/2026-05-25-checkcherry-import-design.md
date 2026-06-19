# Check Cherry → DRB OS Import — Design Spec

**Status:** Revision 11. Folds in /review-spec fleet findings from revisions 1–10. Three-lens fleet returns clean (grounding clean, gaps clean, risk clean).
**Date:** 2026-05-25
**Author:** Dallas + Claude
**Branch:** `cc-import`

---

## 1. Overview

The 2026-05-15 cutover stopped *new* leads from landing in Check Cherry. Historical CC data still lives in Check Cherry and Wix. This spec is a migration — intended one-time but built rerunnable — that brings that history into DRB OS so the financial dashboard, staff pages, and contact records are complete, and so the Check Cherry and Wix subscriptions can be cancelled. **Operational reality:** the CC subscription has ~30 days left as of import-start, and residual activity (payments landing on CC for events booked through it, occasional fallback bookings) will continue during the window. The operator re-downloads the canonical CSVs and re-runs the importer (e.g., `node scripts/cc-import.js --phase=4`) from a terminal as needed during this window; the layered idempotency in Section 10 makes every re-run safe.

Cutover was about new bookings. This is about the long tail: a small slice of real upcoming Confirmed events still in CC, a year-plus of completed events that the financial dashboard should own, and the operator-facing memos (Public Notes, Private Notes) that are useful to keep alongside.

**Headline numbers** (CSV record counts, parsed properly — see Section 4):

- 1,428 total proposals sent in Check Cherry.
- Of those, **209 are Confirmed** — the real events. The other 1,219 are non-Confirmed proposals.
- Of the 209 Confirmed: **27 future, 168 past, 14 internal placeholders (skipped)**.
- 337 payment-or-refund rows: 324 Payments + 13 Refunds. Avg ~1.6 per Confirmed event.
- 116 historical staff payouts.
- 81 leads with UTM attribution; 27 invoice/AR rows.
- Wix: 63 Field Guide Ack + 80 Contractor Profile + 40 Payment Info.

The import is deliberately mixed-fidelity:

- **Confirmed events** become first-class DRB OS records: real `clients`, `proposals`, `shifts`, `proposal_payments`, `proposal_refunds`.
- **Non-Confirmed proposals** become read-only archive rows under `legacy_cc_*` tables.
- **Raw CSV rows** land verbatim in a third archive table so the importer is rerunnable.

## 2. Goals

- One-time, idempotent import of all Check Cherry and Wix data into DRB OS.
- Confirmed events become native records the pipeline already knows how to operate on.
- Past Confirmed events arrive without auto-comms (no review-request blasts for a year of historic events).
- Future Confirmed events arrive WITH auto-comms (T-30, T-7, balance reminders, event-eve SMS, long-lead marketing) so they behave like a native deposit-paid proposal — minus drink-plan-nudge (gated on a drink_plans row existing; cc imports don't create one).
- The financial dashboard, staff pages, and global search reflect the full company history within hours of import.
- After verification, both the Check Cherry subscription and the Wix staff-form site can be cancelled with no ongoing dependency.

### Non-goals

- Two-way sync. CC is being sunset; the operator re-runs the importer manually during the 30-day window. No automation / scheduling.
- Delta-surfacing UI ("what's new since last run"). The Review page's existing orphan/errored sections are sufficient.
- Code-side guards for manual-entry collision. The runbook (Section 14) covers this with operator discipline.
- Recreating CC's full UI. Archive views are minimal lists, not editors.
- Backfilling things we genuinely lost (refund reason text, Stripe refund ids + dates, email/SMS conversation history, signed contract PDFs en masse, drink plans — see Section 12).
- Year-end 1099 reconciliation. The legacy payouts table preserves the data; the 1099 workstream consumes it separately.

## 3. Scope

### In scope

- An importer (Node script: `node scripts/cc-import.js`) that consumes the eight canonical CSVs in `C:\Users\dalla\Downloads\` plus the three Wix exports.
- A Phase 0 file-download step that pulls every URL referenced in the Wix W9/resume columns and the CC report (14) Gallery / Video columns, stores them in R2, and rewrites the URLs into the import.
- New tables: `legacy_cc_raw_imports`, `legacy_cc_proposals`, `legacy_cc_payments`, `legacy_cc_payouts`, `cc_import_runs`, `cc_import_phase0_failures`.
- New columns on existing tables: `cc_id` on `clients`, `proposals`, `users`; `legacy_charge_id` + `payment_method` on `proposal_payments`; `import_status` + `import_notes` on `legacy_cc_raw_imports`; `notes` + `dismissed_at` on `legacy_cc_payments`.
- A `post_event_wrap_up_email` handler registered with the existing `scheduledMessageDispatcher`, wired into `server/index.js` boot sequence.
- Admin "CC Import" route set under `server/routes/admin/ccImport/` (composition router; sub-files `wrapUp.js`, `review.js`, `search.js`) to stay under the 700-line file cap.
- A `?include_cc=<all|exclude|only>` query parameter on the financial dashboard's metrics endpoints + matching filter chip in `MetricsFilterBar`.
- Behavior changes (generally-correct fixes that happen to enable this import):
  - `scheduleDrinkPlanNudge` early-returns when no `drink_plans` row exists for the proposal (Section 9.3.D).
  - `accruePayoutsForProposal(proposalId)` skips when any participating user has `cc_id LIKE 'legacy_cc:%'`; `payrollLateTip.rollForwardLateTip(tipId)` and `payrollClawback.clawbackTip(tipId, ...)` / `clawbackTipByPaymentIntent(piId, ...)` skip when the tip's `target_user_id` has `cc_id LIKE 'legacy_cc:%'` (Section 9.3.E).
- Documentation updates per CLAUDE.md (`README.md` folder tree, `ARCHITECTURE.md` schema and route table additions); listed in Section 15.

### Out of scope

- Two-way sync, ongoing CC polling, or CC webhook ingestion.
- Editing or backfilling drink plans for past events.
- A general-purpose "wrap-up event" handler beyond CC-import use.
- Refunding legacy CC charges (`ch_*`) through the DRB OS Refund button. The existing refund route (`server/routes/stripe.js`) filters payments by `stripe_payment_intent_id IS NOT NULL`, which excludes all legacy rows. Section 11 details the manual-Stripe-reconciliation flow.
- Fixing the pre-existing `drinkPlanNudge.js:147,159` URL bug (uses proposal token where the route expects drink-plan token). Flagged in Section 11 for plan-stage follow-up; CC import does not depend on the broken URL.

## 4. Data inventory

Canonical files in `C:\Users\dalla\Downloads\`. Discard the older redundant exports (`report.csv`, `report (1).csv` … `report (8).csv`, `report (13).csv`).

> **Counting note.** CC CSVs embed newlines inside quoted free-text cells. Naive `wc -l` overcounts. The numbers below are CSV-record counts produced by `csv-parse` (added as a dependency).

| Entity | File | Records | Cols | Notes |
|---|---|---:|---:|---|
| Proposals (all sent) | `report (10).csv` | 1,428 | 57 | `ID` is the CC proposal id. Status: 6 distinct (Section 5). CC's `Event Type` is empty in the export. `Start Time` is `H:MM AM/PM`. `Length` is `"N hours"` or `"N hours, M minutes"`. |
| Clients | `report (9).csv` | 1,215 | 27 | `ID` is the CC client id. `Email` is the dedup key. |
| Payments | `report (11).csv` | 337 | 36 | `Type` is `Payment` (324) or `Refund` (13). `Reference Code` is the Stripe charge id (`ch_...`) when `Processor = Stripe Express` (292); 45 are `Custom` (manual). |
| Leads | `report (12).csv` | 81 | 40 | UTM/marketing. Read-only archive. |
| Invoices / AR | `report (14).csv` | 27 | 42 | Used in Phase 0 to harvest media URLs. |
| Staff payouts | `report (5).csv` | 116 | 5 | `Date, Amount, Payee, Reference, Category`. |
| Wix Field Guide Ack | `Field Guide Acknowledgement.csv` | 63 | 8 | Email + signed acknowledgement. |
| Wix Contractor Profile | `Contractor Profile.csv` | 80 | 16 | Full staff onboarding. |
| Wix Payment Info | `Payment Info.csv` | 40 | 4 | Pay method, handle, W9 URL. |

Dates: `MM-DD-YYYY`. Money: `$X,XXX.XX` with thousands separators; may be negative. All money parsed to integer cents at the parse layer; conversions to/from NUMERIC dollars happen explicitly per column at INSERT sites.

## 5. Buckets

| Bucket | Selection | Count | Treatment |
|---|---|---:|---|
| **A. Confirmed + future** | `Status = Confirmed` AND `Event Date >= today` AND not Bucket D | **27** | Full DRB OS native: `clients` + `proposals` (`status = 'confirmed'`) + `shifts` (`status = 'open'`) + `proposal_payments` + `proposal_refunds`. Auto-comms enabled. |
| **B. Confirmed + past** | `Status = Confirmed` AND `Event Date < today` AND not Bucket D | **168** | Full DRB OS native: `proposals` (`status = 'completed'`) + `shifts` (`status = 'completed'`). Auto-comms NOT scheduled. Operator can hand-pick wrap-up. |
| **C. Non-Confirmed** | Any other `Status` AND not Bucket D | **1,219** | Archive only. Status breakdown: Proposal (Date Open) 1,094, Canceled Proposal 111, Canceled Booking 9, Expired Proposal 4, Postponed Proposal 1. |
| **D. Skip** | `Status = Confirmed` AND Package matches skip rule | **14** | Skipped. Operator-side ledger items. Surfaced on the Review page (Section 9.2 §6) with a "promote this" affordance for any false-skip. |

### 5.1 Skip-package rule

- `SKIP_PACKAGES = new Set(['Inventory', 'MGM Events', 'Bartending Services', 'Victory Gardens Theater Final Reconciliation', 'Theatrical Show Run'])`
- `SKIP_PATTERNS = [/MGM/i]`

Constant in `scripts/cc-import/lib/buckets.js`. 2026-05-25 breakdown: 11 Bartending Services + 2 Inventory + 1 MGM Events = 14. The Section 9.2 §6 "Skipped" surface lets the operator promote any false-skip; the Section 14 sunset gate verifies that surface is empty (or actioned) before cancelling CC.

## 6. Target schema

All statements idempotent.

### 6.1 `legacy_cc_raw_imports`

```sql
CREATE TABLE IF NOT EXISTS legacy_cc_raw_imports (
  id BIGSERIAL PRIMARY KEY,
  source_file TEXT NOT NULL,
  source_entity TEXT NOT NULL,          -- 'events' | 'clients' | 'payments' | 'leads' | 'invoices' | 'payouts' | 'wix_field_guide' | 'wix_contractor' | 'wix_payment_info'
  source_row_number INTEGER NOT NULL,   -- CSV-record (not line)
  source_row_hash TEXT NOT NULL,        -- sha256 of canonicalized JSON
  cc_id TEXT,                           -- CC ID when present; NULL for payments/payouts/leads/invoices
  payload JSONB NOT NULL,
  import_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (import_status IN ('pending','promoted','archived','skipped','duplicate_review','duplicate_confirmed','errored')),
  import_notes JSONB,                   -- conventions below
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_file, source_row_number)
);

CREATE INDEX IF NOT EXISTS idx_legacy_cc_raw_imports_entity ON legacy_cc_raw_imports(source_entity);
CREATE INDEX IF NOT EXISTS idx_legacy_cc_raw_imports_cc_id ON legacy_cc_raw_imports(cc_id) WHERE cc_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_legacy_cc_raw_imports_review ON legacy_cc_raw_imports(import_status) WHERE import_status IN ('duplicate_review','errored');
```

`import_notes` JSON conventions:
- `duplicate_review`: `{"candidate_proposal_id": <int>, "match_reason": "client_id+date_within_14d"}`
- `errored`: `{"error": "<message>", "column": "<col>", "value": "<value>", "phase": <int>}`
- `duplicate_confirmed`: `{"resolved_by_user_id": <int>, "resolved_at": "<iso>", "decision": "duplicate|promote_anyway"}`
- `skipped`: `{"reason": "package_in_skip_list", "package_name": "<name>"}`

### 6.2 `legacy_cc_proposals` (Bucket C + Bucket D)

Bucket D rows are NOT inserted here (they go to raw_imports only with `import_status = 'skipped'`); the Review page query (Section 9.2 §6) reads them from raw_imports.

```sql
CREATE TABLE IF NOT EXISTS legacy_cc_proposals (
  cc_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,                 -- verbatim CC status
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  client_email_normalized TEXT,
  client_name TEXT,
  event_date DATE,
  event_type TEXT,                      -- always NULL from 2026-05-25 export
  package_name TEXT,
  service_name TEXT,
  brand TEXT,
  venue_name TEXT,
  venue_full_address TEXT,
  estimated_guests INTEGER,
  source TEXT,
  lead_type TEXT,
  package_amount_cents INTEGER,
  public_notes TEXT,
  private_notes TEXT,
  booked_at TIMESTAMPTZ,
  raw_import_id BIGINT NOT NULL REFERENCES legacy_cc_raw_imports(id) ON DELETE RESTRICT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_legacy_cc_proposals_client_id ON legacy_cc_proposals(client_id);
CREATE INDEX IF NOT EXISTS idx_legacy_cc_proposals_email ON legacy_cc_proposals(client_email_normalized);
CREATE INDEX IF NOT EXISTS idx_legacy_cc_proposals_event_date ON legacy_cc_proposals(event_date);
```

### 6.3 `legacy_cc_payments` (337 payment+refund rows)

```sql
CREATE TABLE IF NOT EXISTS legacy_cc_payments (
  id BIGSERIAL PRIMARY KEY,
  cc_event_id TEXT,                     -- resolved during Phase 4; NULL on orphan
  cc_event_title TEXT,
  cc_type TEXT NOT NULL CHECK (cc_type IN ('Payment','Refund')),
  paid_on DATE,
  event_date DATE,
  payment_applied_cents INTEGER NOT NULL,  -- absolute value (sign carried by cc_type)
  tip_cents INTEGER NOT NULL DEFAULT 0,
  processing_fee_cents INTEGER NOT NULL DEFAULT 0,
  net_cents INTEGER,
  event_total_cents INTEGER,
  taxable_cents INTEGER,
  total_adjustment_cents INTEGER,
  tax_rate_pct NUMERIC(5,3),
  tax_collected_cents INTEGER,
  payment_method TEXT,                  -- raw CC value
  processor TEXT,                       -- 'Stripe Express' | 'Custom'
  receipt_number TEXT,
  invoice_number TEXT,
  reference_code TEXT,                  -- ch_... when Stripe
  paid_by TEXT,
  assigned_staff TEXT,
  public_notes TEXT,
  private_notes TEXT,
  notes TEXT,                           -- operator note set by Review page's dismiss action
  dismissed_at TIMESTAMPTZ,             -- set when operator dismisses orphan-payment (removes from active queue)
  promoted_payment_id INTEGER REFERENCES proposal_payments(id) ON DELETE SET NULL,
  promoted_refund_id  INTEGER REFERENCES proposal_refunds(id)  ON DELETE SET NULL,
  raw_import_id BIGINT NOT NULL REFERENCES legacy_cc_raw_imports(id) ON DELETE RESTRICT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (raw_import_id),
  CHECK (NOT (promoted_payment_id IS NOT NULL AND promoted_refund_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_legacy_cc_payments_cc_event_id ON legacy_cc_payments(cc_event_id);
CREATE INDEX IF NOT EXISTS idx_legacy_cc_payments_paid_on ON legacy_cc_payments(paid_on);
CREATE INDEX IF NOT EXISTS idx_legacy_cc_payments_reference ON legacy_cc_payments(reference_code) WHERE reference_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_legacy_cc_payments_active ON legacy_cc_payments(id) WHERE dismissed_at IS NULL;
```

### 6.4 `legacy_cc_payouts`

```sql
CREATE TABLE IF NOT EXISTS legacy_cc_payouts (
  id BIGSERIAL PRIMARY KEY,
  payee_name TEXT NOT NULL,
  payee_name_normalized TEXT NOT NULL,
  payee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  paid_on DATE NOT NULL,
  amount_cents INTEGER NOT NULL,
  reference_role TEXT,
  category TEXT,
  raw_import_id BIGINT NOT NULL REFERENCES legacy_cc_raw_imports(id) ON DELETE RESTRICT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (raw_import_id)
);

CREATE INDEX IF NOT EXISTS idx_legacy_cc_payouts_payee_user ON legacy_cc_payouts(payee_user_id);
CREATE INDEX IF NOT EXISTS idx_legacy_cc_payouts_paid_on   ON legacy_cc_payouts(paid_on);
CREATE INDEX IF NOT EXISTS idx_legacy_cc_payouts_payee_normalized ON legacy_cc_payouts(payee_name_normalized);
```

### 6.5 `cc_import_phase0_failures`

```sql
CREATE TABLE IF NOT EXISTS cc_import_phase0_failures (
  id SERIAL PRIMARY KEY,
  source_url TEXT NOT NULL,
  source_entity TEXT NOT NULL,
  source_row_hash TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempted_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolved_r2_key TEXT,
  given_up_at TIMESTAMPTZ,              -- operator marked accepted-loss; counts as 'resolved' for the sunset gate
  given_up_reason TEXT,
  UNIQUE (source_url, source_entity)
);

CREATE INDEX IF NOT EXISTS idx_cc_import_phase0_failures_active
  ON cc_import_phase0_failures(attempt_count)
  WHERE resolved_at IS NULL AND given_up_at IS NULL;
```

Section 11 specifies the give-up workflow: after `attempt_count >= 10`, the row goes to the Review page with an "Accept loss (URL is permanently dead)" action that sets `given_up_at = NOW()` + `given_up_reason = $reason`. The sunset gate (Section 14 #6) accepts rows where either `resolved_at IS NOT NULL` OR `given_up_at IS NOT NULL`.

### 6.6 Columns added to existing tables

```sql
ALTER TABLE clients   ADD COLUMN IF NOT EXISTS cc_id TEXT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS cc_id TEXT;
ALTER TABLE users     ADD COLUMN IF NOT EXISTS cc_id TEXT;

ALTER TABLE proposal_payments ADD COLUMN IF NOT EXISTS legacy_charge_id TEXT;
COMMENT ON COLUMN proposal_payments.legacy_charge_id IS
  'Stripe charge id (ch_...) imported from Check Cherry. NEVER use for Stripe API calls — pass to stripe.refunds.create as `charge:` not `payment_intent:`. New native rows leave this NULL.';

ALTER TABLE proposal_payments ADD COLUMN IF NOT EXISTS payment_method TEXT;
COMMENT ON COLUMN proposal_payments.payment_method IS
  'Free-form method label: card | card_external | cash | check | paypal | other | unknown. Populated by CC import; nullable on native rows.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_cc_id   ON clients(cc_id)   WHERE cc_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_cc_id ON proposals(cc_id) WHERE cc_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cc_id     ON users(cc_id)     WHERE cc_id IS NOT NULL;

-- Per-proposal uniqueness for charge dedup on re-runs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_payments_legacy_charge_unique
  ON proposal_payments(proposal_id, legacy_charge_id)
  WHERE legacy_charge_id IS NOT NULL;

-- Global uniqueness — same Stripe charge across proposals indicates a misroute.
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_payments_legacy_charge_global
  ON proposal_payments(legacy_charge_id)
  WHERE legacy_charge_id IS NOT NULL;
```

`cc_id` on `clients` and `proposals` is the CC ID column (6-digit numeric, TEXT for safety against leading zeros).

On `users`, `cc_id` is set ONLY for legacy contractor stubs created from `report (5).csv` (Section 7.3). Wix-onboarded contractors get their real DRB OS account and leave `cc_id` NULL. The stub's `cc_id` is constructed as `legacy_cc:<slug>:<hash6>`:

- `<slug>`: payee name lowercased, whitespace collapsed, non-alphanumerics removed.
- `<hash6>`: first 6 chars of `sha256(payee_name + '|' + earliest_paid_on_iso)`.

> **Prefix choice:** `legacy_cc:` (not bare `legacy:`) namespaces the import. Future features that need a `legacy:` semantic for unrelated reasons won't collide with the `accruePayoutsForProposal` / `payrollLateTip.recordLateTip` / `payrollClawback.recordClawback` legacy-stub guards (Section 9.3.E), which all match `LIKE 'legacy_cc:%'` exactly.

Stub email: `legacy-cc-<slug>-<hash6>@drbartender.local`. Collision space ~16M; the importer detects the rare slug+date duplicate via `ON CONFLICT (cc_id) WHERE cc_id IS NOT NULL DO NOTHING` returning 0 rows and routes the second payee to the Review page as a stub-creation conflict.

`proposal_payments.payment_method` is added because the CC mapping (Section 8.4) needs to record `cash` / `check` / etc. distinctly. Native rows leave it NULL; consumers that today derive method from `stripe_payment_intent_id` presence are unaffected.

### 6.7 Consumer enumeration for `cc_id`

Server (add `cc_id` to SELECT lists):
- `server/routes/proposals/crud.js` — `GET /proposals`, `GET /proposals/:id`.
- `server/routes/proposals/metadata.js` — financial dashboard list endpoint.
- `server/routes/admin/search.js` — global admin search.
- `server/routes/admin/users.js` — admin user list + detail.
- `server/routes/clients.js` — admin client list + detail.
- `server/routes/clientPortal.js` — client-portal `GET /proposals`.
- `server/utils/globalSearch.js` — search-helper queries.
- `server/utils/metricsQueries.js` — `qSent`, `qAccepted`, `qWinRate`, `qTimeToAccept`, `qLostValue`, `qMoney`, `qOutstanding`, `qRevenue` (the 8 that accept `f`; `qPipelineOutstanding`, `qPaidCount` don't and aren't changed).

Client (display "Imported from CC" badge + accept the filter):
- `client/src/pages/admin/ProposalsDashboard.js`, `ProposalDetail.js`, `ProposalDetailEditForm.js` (badge only, read-only on `cc_id`).
- `client/src/pages/admin/EventDetailPage.js`.
- `client/src/pages/admin/ClientsDashboard.js`, `ClientDetail.js`.
- `client/src/pages/admin/FinancialsDashboard.js` — header + per-row provenance.
- `client/src/pages/public/ClientDashboard.js` — SELECT change only; no badge.
- `client/src/components/adminos/MetricsFilterBar.js` — add the tri-state segmented control (Section 13). Verify the existing prop API before adding the chip.

## 7. Dedup logic

### 7.1 Clients

Dedup rule: **normalized email only** (`LOWER(TRIM(email))`). No phone fallback.

`clients` has a single `name VARCHAR(255) NOT NULL` column (`schema.sql:777`) — no first/last split. The importer writes the CC full name verbatim.

Per CC client row:

1. Normalize email. Empty / whitespace-only / `n/a` / `none` / `noemail@`-pattern → insert with placeholder email `cc-import-noemail-<cc_id>@drbartender.local`, `email_status = 'bad'` (Section 9.1's wrap-up enqueue pre-filters these rows so they never reach the dispatcher), `cc_id`.
2. Look up existing `clients` row by `LOWER(TRIM(email))`. Before any UPDATE that re-canonicalizes the email column, the importer pre-checks for case-collisions:
   ```sql
   SELECT id, email FROM clients
   WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))
   ```
   If the result has more than one row OR has one row whose `email` (after canonicalization) would collide with another row, the importer aborts the row's promotion, writes `import_status = 'errored'` with `import_notes = {"error": "client_email_case_collision", "candidates": [id1, id2]}`, and surfaces on the Review page (errored-row retry). The single-process importer never races itself; this guard covers the operator-vs-importer race (an admin creating a client during import).
3. On a clean dedup hit: `UPDATE clients SET cc_id = $1 WHERE id = $2 AND cc_id IS NULL` plus the canonicalizing `UPDATE clients SET email = LOWER(TRIM(email)) WHERE id = $2 AND email <> LOWER(TRIM(email))`. If the canonicalizing UPDATE errors (race), the importer rolls back this row's SAVEPOINT and writes `import_status = 'errored'` with the conflict details.
4. No hit → INSERT a new `clients` row with name, lowercased email, phone, `source = 'direct'`, `cc_id`.

### 7.2 Confirmed events that ALSO exist in DRB OS

Applied only to Bucket A:

1. After client-dedup, look up native proposals for that client where `cc_id IS NULL`.
2. If any have `event_date` within ±14 days of the CC event's date → `import_status = 'duplicate_review'`.
3. Operator resolves on the Review page (Section 9.2).

Bucket B skips this check.

### 7.3 Staff users

Wix forms (Field Guide Ack + Contractor Profile + Payment Info) all join by email — the union of fields per email becomes one user.

**Wix field precedence on conflict:** Payment Info wins for `preferred_method` and `W9 URL` (it was the more recent update path). Recorded inline in the importer with a comment citing this section.

**Bank PII** — Wix bank fields (account number, routing number) route through `server/utils/encryption.js`'s `encrypt(text)` before INSERT into `payment_profiles.routing_number` and `payment_profiles.account_number` (both VARCHAR(255) per `schema.sql:1992-1993`, widened precisely to store the `enc:` ciphertext prefix). No separate `_encrypted` columns exist — the encryption is encoded inline in the value's prefix.

**Phase 1 hardening — encryption MUST be live.** `encryption.js:8-12` throws only when `NODE_ENV === 'production'`; in any other env it warns and stores plaintext. `encryption.js` exports only `{ encrypt, decrypt }` (no `getKey`). Phase 1 preflight detects an unset key by encrypting a sentinel and checking the prefix:

```js
const { encrypt } = require('./encryption');
const probe = encrypt('cc-import-preflight');
if (!probe.startsWith('enc:')) {
  throw new Error('ENCRYPTION_KEY missing — refuse to write bank PII as plaintext (cc-import Phase 1)');
}
```

`encrypt(text)` returns `'enc:<ciphertext>'` when the key is set, or the raw input (in dev) when not. The prefix check works regardless of `NODE_ENV`. This prevents a local-run-against-prod-DB from silently storing plaintext.

**Payouts CSV** joins users by fuzzy name match after Phase 1. **Name source: `contractor_profiles.preferred_name`** (the `users` table has no first/last/full name columns — only `email`, `password_hash`, `role`, `onboarding_status`, `pre_hired`, timestamps; names live in `contractor_profiles.preferred_name VARCHAR(255)` at `schema.sql:60`). Existing pattern in the codebase: `LEFT JOIN contractor_profiles cp ON cp.user_id = u.id` (see `server/routes/admin/users.js:44`, `server/routes/admin/payroll.js:32`). The fuzzy cascade:

```sql
-- Pass 1: exact match on normalized preferred_name
SELECT u.id FROM users u
  LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
 WHERE LOWER(TRIM(regexp_replace(cp.preferred_name, '[[:space:]]+', ' ', 'g')))
     = LOWER(TRIM(regexp_replace($1, '[[:space:]]+', ' ', 'g')))
```

1. **Pass 1:** exact normalized `preferred_name`.
2. **Pass 2:** normalize comma-flipped names (`"Last, First"` → `"First Last"`) and retry Pass 1.
3. **Pass 3:** last-name + first-initial match (split `preferred_name` by space; compare last token + first initial of the joined-rest).
4. **No match** → create legacy contractor stub: email `legacy-cc-<slug>-<hash6>@drbartender.local`, `onboarding_status = 'deactivated'`, `cc_id = legacy_cc:<slug>:<hash6>`, name in `contractor_profiles.preferred_name`, password = `bcryptjs.hash(crypto.randomBytes(32).toString('hex'), 10)`.

If Pass 3 returns more than one candidate, the payee → Review page as "unmatched payee — multiple candidates" with a user-picker dropdown.

Hourly rate and active/inactive get set manually after import. `can_staff` defaults `true` for any user whose CC payouts reference column is `Bartender` / `Server` / `Barback` AND who has at least one non-`Reimbursement`/`Cash Advance` row. `can_hire` stays false.

**UI affordances** (added to admin staff list):

- "Legacy CC stub (deactivated)" badge for users where `cc_id LIKE 'legacy_cc:%'` AND `onboarding_status = 'deactivated'`. Prevents managers from picking stubs from `shift_requests` dropdowns.
- The raw stub email (`legacy-cc-<slug>-<hash6>@drbartender.local`) is shown only to admin (`auth + adminOnly`); managers see the badge with email redacted.

## 8. Import phases

`node scripts/cc-import.js`, phase subcommands. Each phase wraps work in transactions with per-row SAVEPOINTs (Section 11), writes a row to `cc_import_runs`.

### Phase 0 — File downloads (MUST run before Wix/CC shutdown)

Walks every URL in:
- Wix `Contractor Profile.csv` columns `Resume`, `W9`, duplicated `Resume`.
- Wix `Payment Info.csv` column `Upload your signed W9 (Photo or PDF)`.
- CC `report (14).csv` columns `Gallery URL`, `Video URL`.

R2 keys: `legacy/wix/<slug>/<filename>` or `legacy/cc/<cc-event-id>/<gallery|video>/<index>.<ext>`. URLs rewritten in the CSV-derived payload; original preserved in `legacy_cc_raw_imports.payload`.

**Safety rails:**
- 50 MB per-file cap (HEAD-checked + stream-aborted).
- Content-Type allowlist: `image/*`, `application/pdf`, `video/*`.
- Private-IP block: refuse if hostname resolves to any A/AAAA in `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, or IPv6 link-local.
- 3 retries per attempt; max **10 attempts total** per URL across all runs (`attempt_count` in `cc_import_phase0_failures`).
- Failures persisted to `cc_import_phase0_failures`.

**Closure path for permanently-dead URLs:** after `attempt_count >= 10`, the row surfaces on the Review page (Section 9.2 §7) with an "Accept loss (URL is permanently dead)" action. The action sets `given_up_at = NOW()`, `given_up_reason = $reason`. Sunset gate (Section 14 #6) accepts `given_up_at IS NOT NULL` as resolved.

Per-URL outcome counts to `cc_import_runs.error_summary`.

### Phase 1 — Staff users

1. Parse the three Wix CSVs.
2. **Encryption preflight** (per Section 7.3 sentinel-encrypt-and-check-prefix; use a NON-empty sentinel — `encrypt('')` short-circuits and returns the empty string regardless of key state): abort phase if `ENCRYPTION_KEY` unset, regardless of NODE_ENV.
3. **Index preflight:** create the functional index needed by the email lock (idempotent):
   ```sql
   CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));
   ```
   Without this index, `SELECT ... WHERE LOWER(email) = LOWER($1) FOR UPDATE` sequentially scans `users` and locks every row it touches, blocking every concurrent `users.email` write across the system. The existing `gin (LOWER(email) gin_trgm_ops)` index at `schema.sql:2493` is for prefix/trigram matches and can NOT serve an equality lookup.
4. For each unique email, wrapped in a **per-user transaction** (BEGIN ... COMMIT around the full multi-table fan-out so a partial failure rolls the whole user back), the **`users` upsert uses `INSERT ... ON CONFLICT (email) DO UPDATE`** (UPSERT pattern) rather than a separate lookup-then-INSERT — the UPSERT atomically handles both the "row exists" and "row doesn't exist" cases AND closes the both-terminals-find-zero-and-both-INSERT race that a plain `SELECT FOR UPDATE` does not protect against (FOR UPDATE on zero rows = no lock). The UPDATE branch is **guarded against silently resurrecting deactivated/rejected users and silently flipping non-staff roles** — both of which the previous unconditional `DO UPDATE` would have done:

   ```sql
   INSERT INTO users (email, password_hash, role, onboarding_status, pre_hired)
   VALUES (LOWER(TRIM($1)), $2, 'staff', 'hired', false)
   ON CONFLICT (email)
   DO UPDATE SET onboarding_status = 'hired'
   WHERE users.role = 'staff'
     AND (
       users.onboarding_status NOT IN ('rejected', 'deactivated')
       OR (users.cc_id LIKE 'legacy_cc:%' AND users.onboarding_status = 'deactivated')   -- legacy CC stub: promote to real Wix-onboarded user
     )
   RETURNING id, cc_id, (xmax = 0) AS inserted;
   -- `inserted` distinguishes new-insert from in-place-update; consumer uses it to
   -- skip contractor_profiles re-initialization on existing rows (so an operator
   -- edit to preferred_name isn't clobbered by a Wix CSV value) AND to detect the
   -- stub-promotion case (cc_id IS NOT NULL on the returned row + inserted=false).
   ```

   **Stub promotion is NOT automatic via this UPSERT.** Phase 5's stub email is `legacy-cc-<slug>-<hash6>@drbartender.local`; a Wix-onboarded contractor's real email (e.g., `joe@gmail.com`) is a different value. The UPSERT's `ON CONFLICT (email)` keys off the Wix real email and so will NEVER match the stub row. The UPSERT just INSERTs a fresh real-email user; the stub stays orphaned with its `.local` email and `cc_id LIKE 'legacy_cc:%'`. The carve-out clause `OR (users.cc_id LIKE 'legacy_cc:%' AND users.onboarding_status = 'deactivated')` in the WHERE above is therefore unreachable from the Wix UPSERT path — it exists only as defense-in-depth in case a future code path uses the UPSERT against the stub email directly.

   **Stub-to-real promotion runs through the Section 9.3.E manual link flow.** When the operator opens the CC Import Review page's "Unmatched payouts payees" section, they pick the now-real Wix-onboarded user from the picker (`/search/users`), confirm the link-preview counts, and POST `/unmatched-payee/:legacy_payout_id/link`. That action:
   - Updates `legacy_cc_payouts.payee_user_id` from stub id → real id.
   - Reassigns `shift_requests.user_id` from stub → real (with the 1a/1b DELETE handling in Section 9.3.E).
   - The stub row in `users` stays in place (deactivated, `cc_id LIKE 'legacy_cc:%'`) — orphaned but kept for audit. Do NOT delete; future `legacy_cc_payouts` re-imports (Phase 5 re-runs) need the stub's existence checked separately (Section 8.5).

   Result: same operational outcome (historic shifts and payouts visible on the real user), without the UPSERT carve-out needing to handle the cross-email promotion case.

   **`in_progress` users are intentionally allowed through the UPSERT.** The WHERE allows `users.onboarding_status = 'in_progress'` (the table default) to flip to `'hired'`. A user mid-DRB-OS-native-onboarding who also appears in the legacy Wix CSV gets the Wix-asserted hire status. This is intended — Wix CSV represents people who DID complete the Wix form, which is ground truth for legacy hire status — but the operator should be aware that any in-progress native onboardings get superseded by Phase 1.

   **When the UPSERT returns zero rows** (existing user is `'rejected'`/`'deactivated'` OR `role != 'staff'`), the Wix import row is set aside as a Review-page entry with `import_status = 'errored'` and `import_notes = {"error": "user_email_conflict_with_protected_state", "existing_user_id": ..., "existing_status": ..., "existing_role": ...}`. The operator decides: re-activate manually, merge with a different real user, or skip.

   Case-collision pre-check (pre-existing duplicate emails — `users.email` IS UNIQUE per `schema.sql:14`, so this catches the lossy-import scenario where the email was normalized differently in the past):
   ```sql
   -- Before the UPSERT, pre-check:
   SELECT COUNT(*) FROM users WHERE LOWER(email) = LOWER($1);
   -- If > 1: ROLLBACK; write import_status='errored' with {"error":"user_email_case_collision"}; continue.
   ```
   Then (still inside the per-user transaction):
   - `contractor_profiles` upsert (apply Payment-Info-wins precedence rule for overlapping fields).
   - `agreements` upsert (Field Guide Ack only).
   - `payment_profiles` upsert with `routing_number = encrypt(raw_routing)`, `account_number = encrypt(raw_account)`.
5. After Wix is in, scan `report (5).csv` Payee. For each distinct normalized payee with no Wix match, run Pass 1→2→3 against `contractor_profiles.preferred_name`; on all-miss, insert legacy contractor stub.
6. Auto-derive `can_staff`.

Failures inside a per-user transaction: rollback, write `import_status = 'errored'` for that user's source row, continue with the next user.

### Phase 2 — Clients

1. Load all `report (9).csv` rows into `legacy_cc_raw_imports`.
2. Apply Section 7.1 dedup and upsert into `clients`. Store `cc_id`.
3. Phase 3 rebuilds the `client_cc_id_to_local_id` map at phase start via `SELECT id, cc_id FROM clients WHERE cc_id IS NOT NULL`.

### Phase 3 — Proposals + native promotion

1. Load all `report (10).csv` rows into `legacy_cc_raw_imports`.
2. Classify into Bucket A / B / C / D.
3. Bucket D: `import_status = 'skipped'`.
4. Bucket C: insert into `legacy_cc_proposals`; `import_status = 'archived'`.
5. Bucket A and B: dedup check (Section 7.2 — A only), then promote.

#### 8.3 Bucket A / B promotion shape

Direct INSERTs for `proposals` and `shifts` (no `createEventShifts` reuse — the helper hardcodes `status='open'`, derives `positions_needed` from `proposal.num_bartenders`, and best-effort-calls `createDrinkPlan` in a try/catch wrapper at `eventCreation.js:140`, none of which fit a backfill).

**`proposals` INSERT** (units explicit):

| Column | Source / Default |
|---|---|
| `client_id` | from Phase 2 map |
| `cc_id` | CC `ID` |
| `event_date` | CC `Event Date` parsed `MM-DD-YYYY` |
| `event_start_time` | CC `Start Time` verbatim (`H:MM AM/PM`). NULL if CC value empty — `eventEveSms.js:190` early-returns on null; `balanceScheduler.js:195` regex guard skips unparseable values. Safe degradation. |
| `event_duration_hours` | parsed from CC `Length`: `"1 hour"`→1, `"4 hours"`→4, `"4 hours, 30 minutes"`→4.5, `"55 hours"` (one typo)→defaults to 4 + logged. NUMERIC(4,1). |
| `guest_count` | CC `Estimated Number of Guests`; missing → schema default 50 + raw string preserved in `admin_notes` |
| `event_type` | NULL (CC's column is empty in the export) |
| `event_type_custom` | NULL |
| `event_type_category` | NULL (column exists at `schema.sql:1126` on `proposals` — NOT on `shifts`) |
| `total_price` | **DOLLARS**: `(package_amount_cents + sum(addon_cents)) / 100.0` to 2dp |
| `amount_paid` | **DOLLARS**: `0.00` initially; recomputed at end of Phase 4 |
| `payment_type` | `'deposit'` at Phase 3 (CHECK is `('deposit','full')`); re-derived at end of Phase 4. |
| `status` | Bucket A: `'confirmed'` (re-derived to `'balance_paid'` at end of Phase 4 if `amount_paid >= total_price` — see Section 8.4 step 7); Bucket B: `'completed'` |
| `autopay_enrolled` | `false` |
| `balance_due_date` | Bucket A: `GREATEST(event_date - INTERVAL '14 days', CURRENT_DATE)`. The clamp lands on (not before) today; `balanceReminderScheduling.js:45` uses strict `<` so a `balance_due_date = today` still schedules the `balance_due_today` reminder. Bucket B: NULL. |
| `last_minute_hold` | DEFAULT `false` |
| `venue_name`, `venue_street`, `venue_city`, `venue_state`, `venue_zip` | direct from CC (column is `venue_zip`, NOT `venue_postal_code`) |
| `admin_notes` | CC `Private Notes` (+ guest-count fallback note) |
| `pricing_snapshot` | JSON shaped to feed both consumer families. Two consumers matter: (a) display surfaces (`ProposalView`, `EventDetailPage`, email/PDF templates) read `pricing_snapshot.package` / `.line_items` / `.gratuity_cents`; (b) **payroll** reads `pricing_snapshot.breakdown[]` looking for entries with `label === 'Shared Gratuity'` per `server/utils/payrollMath.js:41-50 extractGratuityCents`. Shape: `{"package": {"name": <pkg>, "amount_cents": <c>}, "gratuity_cents": 0, "line_items": [{"name": <addon>, "qty": <n>, "amount_cents": <c>}, ...], "breakdown": [], "_cc_imported": true, "_cc_id": <id>}`. `breakdown: []` is deliberate — see "Payroll gratuity for imported events" in Section 12 (accepted loss). |
| `created_by` | `(SELECT id FROM users WHERE email = $ADMIN_EMAIL LIMIT 1)` or NULL |
| `created_at` | CC `Booked At` if present, else `NOW()` |
| `sent_at`, `accepted_at` | both = CC `Booked At` (so booked/scheduled/win-rate metrics include legacy events) |

No `proposals.payment_status` column — the lifecycle `status` enum encodes payment progression.

**`proposal_activity_log` entries** (column `action VARCHAR(50)`, no CHECK):
- `cc_import_promoted` (18) — per promoted proposal, `details = {"bucket": "A"|"B", "cc_id": <id>}`.
- `cc_import_public_note` (21) — if CC `Public Notes` non-empty, `details = {"public_notes": "<text>"}`.

**`shifts` INSERT** (direct). Column names below match the actual `shifts` schema (`schema.sql:269-289`) and the existing `createEventShifts(proposalId)` insert pattern at `server/utils/eventCreation.js:118-135`:

| Column | Source / Default |
|---|---|
| `proposal_id` | the new proposal id |
| `event_type`, `event_type_custom` | mirrored from proposal (both NULL since CC's Event Type column is empty) |
| `client_name` | `clients.name` (single column, no first/last split — `clients.name VARCHAR(255) NOT NULL` at `schema.sql:777`) |
| `event_date` | mirrored from proposal |
| `start_time` | `VARCHAR(50)`, copied verbatim from `proposal.event_start_time` (both stored as `H:MM AM/PM` per CC's export — same format `createEventShifts:127` produces). No shift-back by `setup_minutes_before` — that's native pre-event prep window calculation, not part of this backfill (existing `createEventShifts` also doesn't shift, per the comment at `eventCreation.js:116-117`). |
| `end_time` | `VARCHAR(50)`, computed as `start_time + event_duration_hours` formatted back to `H:MM AM/PM`. **Note:** the existing `addHoursToTime` / `formatTime12` helpers in `server/utils/eventCreation.js:9,23` (a) parse 24-hour `HH:MM` only, not `H:MM AM/PM`, and (b) are file-scoped, not exported. The importer ships a small dedicated 12-hour-arithmetic helper in `scripts/cc-import/lib/timeFormat.js` (parse `H:MM AM/PM` → minutes since midnight → add hours → format back). ~15 lines, independent of `eventCreation.js`. |
| `location` | composed via `venueAddress.composeVenueLocation(...)` (the column is `location`, not `venue_location`) |
| `setup_minutes_before` | package default (60) |
| `positions_needed` | `JSON.stringify(Array(N).fill('Bartender'))` where N = Bucket A: `max(1, comma_count(CC.Assigned Staff) + 1)`; Bucket B: `1`. The one-time normalization migration at `schema.sql:1972-1985` (a DO-block backfill, not a per-row trigger) rewrote historic non-`[`-prefixed values to `'[]'`; new INSERTs must be valid JSON or downstream JSON parsers will throw. |
| `notes` | `'Imported from Check Cherry (cc_id=<id>)'` — mirrors the native `createEventShifts` convention at `eventCreation.js:132` of writing a descriptive auto-string into `notes`, so the operator-facing shift detail page doesn't show a blank notes field for imported shifts. (CC's per-event Public/Private Notes still live on proposal-side via `admin_notes` + the `cc_import_public_note` activity log.) |
| `status` | Bucket A: `'open'`; Bucket B: `'completed'` |
| `created_by` | same value as `proposals.created_by` (admin user id from `ADMIN_EMAIL` lookup or NULL) |

`shifts` has NO `client_id` column (the join to client goes via `proposals.client_id`); no `event_type_category` column (only `event_type` + `event_type_custom`); no `num_bartenders` column (the count lives in `positions_needed`'s JSON array length, and `num_bartenders` is on `proposals`). The importer does NOT mirror `proposal.event_start_time` directly into a `shifts.event_start_time` column — `shifts.start_time` is the real column (VARCHAR(50)), populated via the time-arithmetic derivation that `createEventShifts` uses.

**`shift_requests` INSERT** — per assigned-staff name from CC `Assigned Staff`:

```sql
INSERT INTO shift_requests (shift_id, user_id, status)
VALUES ($1, $2, 'approved')
ON CONFLICT (shift_id, user_id) DO NOTHING;
```

`'approved'` per CHECK (`'pending','approved','denied'`). Match via Section 7.3 cascade.

**Auto-comms enrollment (Bucket A only):**

After the proposal+shift inserts commit, the importer calls in this order:

```js
await scheduleDepositPaidReminders(proposalId, { source: 'cc_import' });
await onProposalSignedAndPaid(proposalId);
```

- `scheduleDepositPaidReminders` (`server/utils/depositPaidSchedulers.js:15`) wraps both `scheduleBalanceReminders` and `schedulePreEventReminders` with Sentry.
- `onProposalSignedAndPaid` (`server/utils/marketingHandlers.js`, called by `server/routes/stripe.js:1313`) enrolls `scheduleNewYearHello`, `scheduleSixMonthsOut`, cancels drip touches.

Both calls are wrapped in `try { ... } catch (err) { Sentry.captureException(err, { tags: { phase: 'cc_import_phase3', step: 'auto_comms_enroll', proposalId } }); /* continue */ }`. **Re-call safety:** `scheduleMessage`'s ON CONFLICT against the partial unique on `(entity_id, entity_type, message_type, recipient_id, recipient_type, channel) WHERE status='pending'` makes any individual re-call a no-op for an already-pending row. A Phase 3 re-run for the same proposal is safe.

`schedulePreEventReminders` transitively schedules `drink_plan_nudge` / `drink_plan_nudge_sms`. The fix is at the helper level (Section 9.3.D): `scheduleDrinkPlanNudge` early-returns when no `drink_plans` row exists. CC imports create no `drink_plans` row, so the nudge silently no-ops.

For Bucket B: NO scheduler is called. `status='completed'` means `processEventCompletions` (`balanceScheduler.js:183 — WHERE status IN ('balance_paid','confirmed')`) never picks it up.

### 8.4 Phase 4 — Payments and refunds

1. Load all `report (11).csv` rows into `legacy_cc_raw_imports` and `legacy_cc_payments`.
2. Resolve `cc_event_id` per row by matching on `(event_date, total_price)` with a deterministic tiebreak. The actual `report (11).csv` export has no email column, so an email-side filter is not available — the match is purely the date + dollar-amount tuple plus the CC-import scope filter:
   ```sql
   SELECT p.id, p.total_price, p.amount_paid, p.status
     FROM proposals p
    WHERE p.cc_id IS NOT NULL
      AND p.event_date = $1
      AND p.total_price = $2
   ```
   Multiple candidates → deterministic tiebreak (highest unpaid balance, then lowest `proposals.id`).

   *Sunset gate:* the operator should manually verify any cases where multiple cc-imported proposals share the same `event_date` AND `total_price` before sunsetting the import staging tables — those are the rows that could absorb a payment onto the wrong proposal under the deterministic tiebreak.
3. Still-ambiguous → `cc_event_id = NULL`, surface on Review page.
4. For each `Payment` row that resolved a `cc_event_id`:
   - **Idempotency SELECT-then-skip:** `SELECT 1 FROM legacy_cc_payments WHERE id = $legacy_id AND promoted_payment_id IS NOT NULL`. If present, skip.
   - INSERT into `proposal_payments` (full column list):
     - `proposal_id` = the matched proposal id.
     - `amount` (cents) = `Payment Applied` parsed.
     - `fee_cents` = `Processing Fees`.
     - `payment_type` = computed per the per-event chronological sequence (below).
     - `payment_method` = mapped per the table below.
     - `stripe_payment_intent_id` = NULL.
     - `legacy_charge_id` = `Reference Code` if `ch_*`, else NULL.
     - `created_at` = `<paid_on>T12:00:00Z` (overrides DEFAULT NOW() so financial-dashboard "paid" lens reports on actual paid dates).
     - `status = 'succeeded'`.
     - Stripe rows: `ON CONFLICT (proposal_id, legacy_charge_id) WHERE legacy_charge_id IS NOT NULL DO NOTHING`. Global-unique partial also catches misroutes.
   - Set `legacy_cc_payments.promoted_payment_id`.
5. For each `Refund` row that resolved a `cc_event_id` — **full mirror of `refundHelpers.js:118-260`'s Approach A, with the row lock + status demote + autopay clear**:
   - **Idempotency SELECT-then-skip:** `SELECT 1 FROM legacy_cc_payments WHERE id = $legacy_id AND promoted_refund_id IS NOT NULL`. If present, skip.
   - **Manual-reconciliation skip:** `SELECT id FROM proposal_refunds WHERE proposal_id = $1 AND reason LIKE 'Manual Stripe reconciliation%' AND amount = $2 AND created_at >= $paid_on - INTERVAL '1 day' AND created_at <= $paid_on + INTERVAL '1 day' LIMIT 1`. If a matching row exists, skip and mark `legacy_cc_payments.promoted_refund_id = <manual-row id>`. **Note:** this `reason` prefix is a NEW convention introduced by this spec; no historical rows use it, so no backfill is required. The ±24h+exact-amount tolerance is intentionally loose because the operator typically records the manual row within a day of the Stripe refund; the tightening lever (e.g., requiring a `legacy_charge_id` tag on the manual row) is available if false-matches ever surface.
   - Wrap the entire refund's pair of writes in a transaction with a row lock. **Must use `pool.connect()` to acquire a dedicated client** (mirrors `refundHelpers.js:108` pattern) — naive `pool.query('BEGIN'); pool.query('SELECT ... FOR UPDATE')` would land on two different auto-commit connections, releasing the lock before the SELECT runs:
     ```js
     const client = await pool.connect();
     try {
       await client.query('BEGIN');
       const lockRes = await client.query(
         'SELECT total_price, amount_paid, status FROM proposals WHERE id = $1 FOR UPDATE',
         [proposalId]
       );
       // ... compute totals, INSERT proposal_refunds, UPDATE proposals #1 (money), UPDATE proposals #2 (status demote), set legacy_cc_payments.promoted_refund_id, all via client.query ...
       await client.query('COMMIT');
     } catch (err) {
       await client.query('ROLLBACK');
       throw err;
     } finally {
       client.release();
     }
     ```
     The SELECT FOR UPDATE locks `total_price, amount_paid, status` only — matches `refundHelpers.js:118-121`'s precedent. The status-demote UPDATE #2 reads `autopay_enrolled` inline in its CASE and doesn't need it in the lock SELECT.
   - Compute `refund_amount_cents = abs(payment_applied_cents)`.
   - **Refund-without-payment assertion (subtract prior refunds):**
     ```sql
     SELECT
       COALESCE((SELECT SUM(amount) FROM proposal_payments WHERE proposal_id = $1 AND status='succeeded'), 0)
     - COALESCE((SELECT SUM(amount) FROM proposal_refunds  WHERE proposal_id = $1 AND status='succeeded'), 0)
       AS net_paid_cents
     ```
     If `net_paid_cents < refund_amount_cents`, write `import_status = 'errored'` with `import_notes = {"error": "refund_exceeds_net_paid", "refund_cents": <c>, "net_paid_cents": <c>}`, log to Sentry, ROLLBACK, continue.
   - Snapshot `total_price_before = proposals.total_price` (locked row).
   - Compute `total_price_after = GREATEST(total_price_before - refund_amount_cents / 100.0, 0)`.
   - INSERT into `proposal_refunds`:
     - `proposal_id`, `payment_id = NULL`, `stripe_payment_intent_id = NULL`, `stripe_refund_id = NULL`.
     - `amount = refund_amount_cents`.
     - `reason = 'Legacy Check Cherry import — refund reason not exported'`.
     - `total_price_before`, `total_price_after` (DOLLARS).
     - `status = 'succeeded'`.
     - `created_at = <paid_on>T12:00:00Z`.
   - **UPDATE #1 — money (mirrors `refundHelpers.js:230-236` Approach A):**
     ```sql
     UPDATE proposals
        SET total_price = GREATEST(total_price - ($1 / 100.0), 0),
            amount_paid = GREATEST(amount_paid - ($1 / 100.0), 0)
      WHERE id = $proposal_id;
     ```
     (For legacy CC refunds we treat the full refund as the contract portion — CC's export doesn't distinguish contract vs extra-scope, and a $-for-$ reduction of both columns matches what the operator would have manually entered.)
   - **UPDATE #2 — status demote + autopay clear (sequential, reads the now-current `amount_paid` from UPDATE #1; mirrors `refundHelpers.js:245-264`):**
     ```sql
     UPDATE proposals
        SET status = CASE
              WHEN status NOT IN ('balance_paid','deposit_paid') THEN status   -- preserve 'completed' (terminal), 'confirmed', and earlier lifecycle states
              WHEN amount_paid <= 0                              THEN 'accepted'
              WHEN amount_paid <  total_price                    THEN 'deposit_paid'
              ELSE status                                         -- amount_paid >= total_price → still fully paid at the corrected total
            END,
            autopay_enrolled = CASE
              WHEN status = 'balance_paid' AND amount_paid < total_price THEN false
              ELSE autopay_enrolled
            END
      WHERE id = $proposal_id;
     ```
     The outer `WHEN status NOT IN ('balance_paid','deposit_paid') THEN status` first branch mirrors `refundHelpers.js:264`'s `['balance_paid','deposit_paid'].includes(statusBefore)` guard — prevents a Bucket B `'completed'` proposal from being silently demoted to `'accepted'` on a full refund. The two-UPDATE sequence (money first, then status) is deliberate: UPDATE #2 reads the just-committed `amount_paid` to make the demote decision. Both UPDATEs happen inside the row-lock transaction.
     Without these demotes, an imported partial refund leaves the proposal flagged "Paid in Full" when it isn't, AND leaves `autopay_enrolled = true` so the next `balanceScheduler` tick recharges the exact amount just refunded. The cross-cutting bug `refundHelpers.js` exists to prevent.

   **UX consequence of the GREATEST(..., 0) clamps in UPDATE #1.** If a CC refund's amount exceeds the current `total_price` (rare — a post-event scope reduction the CC export missed), both `total_price` and `amount_paid` clamp to 0. UPDATE #2's CASE finds `amount_paid >= total_price` (both zero) and falls into the `ELSE status` branch, leaving the lifecycle status unchanged. The proposal becomes a `$0 completed event` on the financial dashboard — coherent (a fully-refunded event reads as $0) but visually odd if not anticipated. Operator can identify these via `SELECT * FROM proposals WHERE cc_id IS NOT NULL AND total_price = 0 AND status = 'completed'` after Phase 4 if any need investigation.
   - Set `legacy_cc_payments.promoted_refund_id`.
   - COMMIT.
6. After all payment and refund rows processed, recompute `proposals.amount_paid` from scratch (idempotent):
   ```sql
   UPDATE proposals
      SET amount_paid = ((COALESCE((SELECT SUM(amount) FROM proposal_payments p WHERE p.proposal_id = $1 AND p.status='succeeded'), 0)
                       - COALESCE((SELECT SUM(amount) FROM proposal_refunds  r WHERE r.proposal_id = $1 AND r.status='succeeded'), 0)
                       )::numeric / 100.0)::numeric(10,2)
    WHERE id = $1;
   ```
   `::numeric(10,2)` cast uses Postgres half-away-from-zero rounding, which matches `Math.round` (half-up) for non-negative values — consistent with the rest of the money path.
7. Re-derive `proposals.payment_type` AND `proposals.status` for cc-imported proposals:
   ```sql
   UPDATE proposals
      SET payment_type = CASE WHEN amount_paid >= total_price THEN 'full' ELSE 'deposit' END,
          status       = CASE
            WHEN cc_id IS NOT NULL
              AND status = 'confirmed'
              AND amount_paid >= total_price
              AND event_date >= CURRENT_DATE   -- Bucket A only; Bucket B is already 'completed'
            THEN 'balance_paid'
            ELSE status
          END
    WHERE cc_id IS NOT NULL;
   ```
   Bucket A fully-paid: `'confirmed'` → `'balance_paid'`, mirroring `stripe.js:1046,1057,1100`. The "Paid in Full" chip, autopay decision logic, and record-payment gate all see a consistent state. Bucket B stays `'completed'` (terminal).

8. **Suppress now-stale balance-reminder rows.** Phase 3 calls `scheduleDepositPaidReminders` for every Bucket A event (before payments are imported), which schedules a `balance_reminder_*` ladder against `amount_paid = 0.00`. Phase 4 fills in payments, recomputes `amount_paid` (step 6), and re-derives status (step 7). For a Bucket A event that arrives already paid-in-full at CC, the ladder rows now point at a settled balance — the dispatcher handlers (`scheduledMessageDispatcher.js:601`, `:625`) throw `'balance reminder fired but balance is zero or negative'` when they fire, producing 4 Sentry exceptions per fully-paid Bucket A event over the next weeks. Sweep them now:
   ```sql
   UPDATE scheduled_messages sm
      SET status = 'suppressed',
          error_message = 'cc-import: balance settled at import'
    WHERE sm.entity_type = 'proposal'
      AND sm.status = 'pending'
      AND sm.message_type IN (
        'balance_reminder_autopay_t3',
        'balance_reminder_non_autopay_t3',
        'balance_due_today',
        'balance_late_t1',
        'balance_late_t3',
        'balance_due_today_sms',
        'balance_late_t1_sms',
        'balance_late_t3_sms'
      )
      AND sm.entity_id IN (
        SELECT id FROM proposals
         WHERE cc_id IS NOT NULL
           AND amount_paid >= total_price
      );
   ```
   Suppresses cleanly without firing the handlers, no Sentry noise, no client-visible effect (no email/SMS would have sent anyway — the throw happens pre-send).

#### Payment-type chronological-sequence rule (with example)

Per proposal, order payments by `paid_on ASC`:
- First payment: `'full'` if `amount >= proposal.total_price`, else `'deposit'`.
- Subsequent payments: `'balance'`.

**Example.** Bucket B event with `total_price = $1,000`, three CC payments: $100, $700, $200. → `'deposit'`, `'balance'`, `'balance'`.

Tip rows (`Tip Amount` column) are not separate `proposal_payments` rows.

#### CC Payment-method mapping

| CC `Type` | CC `Payment Method` | CC `Processor` | `proposal_payments.payment_method` | `legacy_charge_id` |
|---|---|---|---|---|
| Payment | Credit Card | Stripe Express | `'card'` | populated |
| Payment | Credit Card | Custom | `'card_external'` | NULL |
| Payment | Cash | * | `'cash'` | NULL |
| Payment | Check | * | `'check'` | NULL |
| Payment | Paypal | * | `'paypal'` | NULL |
| Payment | Other | * | `'other'` | NULL |
| Payment | None | * | `'unknown'` + log to review | NULL |
| Refund | * | * | (refund row, see step 5) | n/a |

### 8.5 Phase 5 — Payouts

1. Load all `report (5).csv` rows into `legacy_cc_raw_imports` and `legacy_cc_payouts`.
2. **Skip the cascade on re-runs when already linked.** For each `legacy_cc_payouts` row, check `SELECT payee_user_id FROM legacy_cc_payouts WHERE raw_import_id = $1`. If the existing row has `payee_user_id IS NOT NULL` (set by a prior Phase 5 run OR by the operator via Section 9.3.E `/unmatched-payee/.../link`), keep the existing value; do NOT re-derive. This prevents Phase 5 re-runs from routing a payee whose stub has been operator-promoted into a fresh stub.
3. For unresolved rows (`payee_user_id IS NULL`), resolve via the Section 7.3 fuzzy cascade against `users` (real + stubs).
4. No event link (CSV doesn't carry one).

### 8.6 Phase 6 — Leads & invoices archive

1. Load `report (12).csv` (81 leads) into `legacy_cc_raw_imports`.
2. Load `report (14).csv` (27 invoices) into `legacy_cc_raw_imports`.

## 9. Admin pages

### 9.1 Wrap-up bulk action page (`/admin/cc-import/wrap-up`)

**Route:** `server/routes/admin/ccImport/wrapUp.js`. `auth, requireAdminOrManager`. URL state via `?page=N&filter=<needs-wrapup|all>&range=<since-import|last-30>` (refresh preserves position + filter + quick-filter selection).

**Worklist query** (default: all Bucket B since import start; "Needs wrap-up only" toggle defaulted on):

```sql
SELECT p.id, p.cc_id, p.event_date, c.id AS client_id, c.name AS client_name,
       c.email, c.email_status,
       p.event_type, p.total_price, p.amount_paid,
       EXISTS (
         SELECT 1 FROM scheduled_messages sm
          WHERE sm.entity_type = 'proposal' AND sm.entity_id = p.id
            AND sm.message_type = 'post_event_wrap_up_email'
            AND sm.status IN ('pending','sent')
       ) AS wrap_up_done
  FROM proposals p
  JOIN clients c ON c.id = p.client_id
 WHERE p.cc_id IS NOT NULL
   AND p.status = 'completed'
   AND p.event_date < CURRENT_DATE
 ORDER BY p.event_date DESC
 LIMIT $page_size OFFSET $offset;
```

Toggle to "Needs wrap-up only" adds `AND NOT EXISTS(...wrap_up_done...)`. Quick-filter button "Last 30 days" applies `AND p.event_date >= CURRENT_DATE - INTERVAL '30 days'`. URL `range=since-import` maps to OMITTING the date clause entirely (no synthetic "import start" cutoff); `range=last-30` adds the 30-day clause.

**Header counts:** `Total Bucket B: N | Needs wrap-up: M | Last 30 days: K`.

**UI states:**
- Loading: skeleton table.
- Empty (Needs-wrap-up-only / zero): "All Bucket B wrap-ups have been sent. Toggle off to see the full list."
- Empty (filtered / zero): "No Check Cherry events match the current filter."
- Error: banner with retry.
- Disabled: bulk-action button when selected = 0; spinner during in-flight.

**Selection:** cap 50 per page. "Select all" header checkbox selects the first 50 visible rows.

**Pre-flight preview:** before the confirm modal, a sidebar runs each candidate through gating helpers server-side **with no DB writes**.

- `checkSuppression` (file-internal in `scheduledMessageDispatcher.js:122`) is pure (SELECT + branch); the spec adds it to the dispatcher's `module.exports`.
- `resolveDelivery` (`scheduledMessageDispatcher.js:229-292`) is **NOT safe to call from a preview** — it `UPDATE scheduled_messages SET status='suppressed' WHERE id = $1`, calls `suspendClientAutomation(row.recipient_id)` (which suppresses every pending row for that client per `clientAutomationSuspension.js:13-27`), and fires `alertNoWorkingChannel` (admin email). Preview candidates have not been enqueued yet (`row.id` is undefined); calling it would either crash or zero out unrelated client automation.
- The preview uses the existing pure helper `resolveChannelFallback` (exported from `server/utils/channelFallback.js`) wrapped in a tiny `previewDelivery(client, channel)` shim that returns `{ outcome: 'proceed' | 'no_working_channel' | 'channel_substituted', resolvedChannel }` without writing. No DB mutations, no suspensions, no admin emails.

The preview ignores `shouldDeferForOverlap` (handler is `cooldownExempt: true`). Preview shows `X of N will be skipped (Y bad email — informational only; wrap-up is operational and would send anyway except for the bad-email pre-filter in the enqueue endpoint)`.

**Bulk action endpoint:** `POST /api/admin/cc-import/wrap-up/enqueue`, body `{ proposal_ids: [int, ...] }`.

Server validation:
- `proposal_ids` required, array of integers, length 1–50. `ValidationError` on violation.
- Each id must exist and have `cc_id IS NOT NULL AND status = 'completed' AND event_date < CURRENT_DATE`. Missing/invalid → that id gets `outcome: 'invalid_target'`; the batch continues with the others.

For each id, the server:
- **Pre-filters bad-email rows:** if `clients.email_status = 'bad'` OR `clients.email LIKE 'cc-import-noemail-%@drbartender.local'`, the enqueue is skipped with `outcome: 'no_email'`.
- **Dedup check:** `SELECT 1 FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1 AND message_type='post_event_wrap_up_email' AND status IN ('pending','sent') LIMIT 1`. If a row exists, skip with `outcome: 'already_enqueued'`. (Covers the case where the operator double-clicks AND the previous-batch dedup window has moved past `pending` to `sent` — `scheduleMessage`'s own ON CONFLICT only protects the `pending` window.) **`'failed'` and `'suppressed'` are deliberately NOT in the dedup set:** an operator can re-enqueue a wrap-up after a delivery failure (Resend bounce, Twilio error) OR after a per-channel suppression (bad email) without the dedup blocking the retry. The operator workflow: fix the client email → return to wrap-up page → re-select the row → re-enqueue. The new pending row will land cleanly because the previous `'suppressed'` row doesn't match the dedup filter. This matches the existing pattern at `scheduleMessage` where partial-unique only covers `pending`.
- Calls `scheduleMessage({ entityType: 'proposal', entityId, messageType: 'post_event_wrap_up_email', recipientType: 'client', recipientId: client_id, channel: 'email', scheduledFor: NOW() })`.
- Writes `proposal_activity_log` action `cc_wrap_up_enqueued` and `logAdminAction({ actorUserId: req.user.id, targetUserId: client_id, action: 'cc_wrap_up_enqueued', metadata: { proposal_id, cc_id } })`.

Response: `{ results: [{ proposal_id, outcome, message? }] }`. `outcome` enum:
- `'enqueued'` — scheduleMessage returned a new row.
- `'already_enqueued'` — dedup hit (pending or sent within the window).
- `'no_email'` — bad-email pre-filter.
- `'invalid_target'` — id failed validation.
- `'error'` — unexpected exception (`message` populated; Sentry captured).

Client-side per-row feedback: after enqueue, page re-fetches the worklist (status badges come from server-side `wrap_up_done`). Per-row `outcome` strings are surfaced in a transient toast / table-row badge that persists until next navigation.

### 9.2 Review page (`/admin/cc-import/review`)

**Route:** `server/routes/admin/ccImport/review.js`. `auth, requireAdminOrManager`.

**Shared validation pattern for all 8 action endpoints + 2 picker endpoints:**

- Body validated against an inline schema (object shape, types, required-vs-optional, max lengths).
- `Number.isInteger` checks on every `*_id` field.
- Existence check: `SELECT 1 FROM <target_table> WHERE id = $1 [AND <state guard>]` before mutation. Missing → `NotFoundError`; wrong state → `ConflictError`.
- `reason` / `notes` text fields: max 2,000 chars; `ValidationError` on overflow.
- Picker `q`: required string, 2 ≤ length ≤ 100, used in `ILIKE` query with `$1` parameterization (no string concatenation; existing `pool.query` parameterization handles escape).
- Every endpoint: try/catch around the mutation; unexpected exceptions → `Sentry.captureException(err, { tags: { route: req.path, user_id: req.user.id }})` + `AppError` thrown for client-visible failures.
- Every successful mutation: `logAdminAction({ actorUserId: req.user.id, action: '<route-specific>', metadata: <route-specific> })`.

**Six collapsible sections** (each with its own loading/empty/error state):

1. **Suspected duplicates** — `legacy_cc_raw_imports WHERE import_status = 'duplicate_review' AND source_entity = 'events'`.
   - Empty: "No suspected duplicates."
   - `POST /api/admin/cc-import/review/duplicate/:row_id/confirm` — body `{}`. State guard: `import_status = 'duplicate_review'`. Flips to `duplicate_confirmed` with `decision: 'duplicate'`. Audit.
   - `POST /api/admin/cc-import/review/duplicate/:row_id/promote` — body `{ confirm_candidate_edited?: boolean }`. State guard: `import_status = 'duplicate_review'` (refuses if already actioned, even on double-click). If candidate proposal's `updated_at > legacy_cc_raw_imports.imported_at`, returns 409 with `{ candidate_edited: true, last_edited_at }` unless `confirm_candidate_edited: true`. Re-runs Bucket A insert flow for the single row in a transaction with the dedup check bypassed. Flips to `duplicate_confirmed` with `decision: 'promote_anyway'`. Audit.

2. **Orphan payments** — `legacy_cc_payments WHERE promoted_payment_id IS NULL AND promoted_refund_id IS NULL AND cc_event_id IS NULL AND dismissed_at IS NULL`.
   - Empty: "No orphan payments."
   - Picker: `GET /api/admin/cc-import/search/proposals?q=<term>&limit=25&offset=0` returning `{ items: [{ id, cc_id, client_name, event_date, total_price }], total }`, ranked by `clients.name ILIKE` + `event_date` proximity. Default `LIMIT 25`, server-side pagination via `offset`. Debounced 300ms on client. Loading/empty/error states on the dropdown.
   - `POST /api/admin/cc-import/review/orphan-payment/:legacy_id/link` — body `{ proposal_id }`. Sets `legacy_cc_payments.cc_event_id`, re-runs Phase 4 single-row promotion. **Also re-runs the proposal-wide recomputes** (step 6 `amount_paid` from scratch + step 7 `payment_type` and `status` re-derive) so the proposal doesn't drift out of sync. Audit.
   - `POST /api/admin/cc-import/review/orphan-payment/:legacy_id/dismiss` — body `{ reason?: string }` (max 2,000 chars). Sets `legacy_cc_payments.dismissed_at = NOW()`, `notes = $reason`. Removes from the active queue (the index filter `WHERE dismissed_at IS NULL`). Audit.

3. **Unmatched payouts payees** — `legacy_cc_payouts WHERE payee_user_id IS NULL`.
   - Empty: "All payouts are linked to a user."
   - Picker: `GET /api/admin/cc-import/search/users?q=<term>&include_stubs=<bool>&limit=25&offset=0` returning `{ items: [{ id, name, email, cc_id, onboarding_status }], total }`. Default `LIMIT 25`. Stubs excluded by default (`AND (cc_id IS NULL OR cc_id NOT LIKE 'legacy_cc:%')`); toggle includes them. **`include_stubs=true` is restricted to `auth + adminOnly`** because the stub `.local` email could expose contractor identity-derived data; managers see stubs only via the redacted badge in the staff-list UI (Section 7.3 affordance). When called by a manager with `include_stubs=true`, the endpoint **returns 403** with `{ error: 'include_stubs requires admin role' }` (surfaces the attempt in audit log; safer than silent downgrade which would hide a frontend bug). **Frontend pairing:** the picker UI hides the `include_stubs` toggle entirely when `req.user.role !== 'admin'` — the 403 is the server-side safety net, the UI hide is the prevention. Non-stub user emails ARE visible to managers because those emails are already visible in the existing admin staff list (pre-existing exposure boundary). Loading/empty/error states.
   - `POST /api/admin/cc-import/review/unmatched-payee/:legacy_payout_id/link` — body `{ user_id }`. Updates `legacy_cc_payouts.payee_user_id`. Audit.
   - `POST /api/admin/cc-import/review/unmatched-payee/:legacy_payout_id/create-stub` — body `{}`. Creates stub per Section 7.3 (transactional, with the `cc_id` collision check), links payouts, returns the new user. **The next picker search includes the just-created stub** because the create-stub action itself returns the new user's id and the UI auto-selects it in the link field; the operator can then confirm in one click rather than re-searching. Audit.

4. **Unmatched assigned-staff names** — flat list from `cc_import_runs.notes`.
   - Empty: "All shift assignments matched a user."
   - Read-only (fix via standard shift-edit UI).

5. **Type-coercion failures** — `legacy_cc_raw_imports WHERE import_status = 'errored'`.
   - Empty: "No failed rows."
   - Each row shows `import_notes.error` + `column` + `value` so the operator can see WHY it failed.
   - `POST /api/admin/cc-import/review/errored-row/:row_id/retry` — body `{ payload_override?: <JSON> }`. If `payload_override` provided, replaces `legacy_cc_raw_imports.payload` before retry (lets the operator fix a malformed value in-place instead of re-uploading the CSV). Re-runs the per-row insert. On success → `import_status = 'promoted'`/`'archived'`; on failure → stays `errored` with updated `import_notes`. Audit.

6. **Skipped (Bucket D)** — `legacy_cc_raw_imports WHERE import_status = 'skipped' AND source_entity = 'events'`.
   - Empty: "No skipped rows. Section 5.1 skip-package rule did not match any CC events."
   - Shows each skipped event's package name + client + event_date so the operator can spot a false-skip (e.g., a real client event labeled `'Bartending Services'`).
   - `POST /api/admin/cc-import/review/skipped-event/:row_id/promote` — body `{}`. Re-runs the Phase 3 promotion flow for that single row with the skip rule bypassed (so the row goes to its natural bucket A/B/C based on status + date). Flips `import_status = 'promoted'`/`'archived'`. Audit.

7. **Phase 0 give-ups** — split into two sub-tabs:
   - **Eligible:** `cc_import_phase0_failures WHERE attempt_count >= 10 AND given_up_at IS NULL`.
     - Empty: "No Phase 0 URLs are eligible for give-up."
     - `POST /api/admin/cc-import/review/phase0-failure/:row_id/accept-loss` — body `{ reason: string }` (required, 1–500 chars). Sets `given_up_at = NOW()`, `given_up_reason = $reason`. Audit.
   - **Already actioned:** `cc_import_phase0_failures WHERE given_up_at IS NOT NULL`.
     - Empty: "No URLs have been marked as accepted-loss yet."
     - Read-only, sortable by `given_up_at DESC`.
     - `POST /api/admin/cc-import/review/phase0-failure/:row_id/revert-give-up` — body `{}`. Sets `given_up_at = NULL`, `given_up_reason = NULL`, **AND `attempt_count = 0`** (the 10-attempt cap from Section 8.0 would otherwise reject the revived row on the next Phase 0 run). Audit. **Intent:** revert exists for when the URL becomes fetchable again (operator re-uploaded the W9, Wix CDN restored), NOT to silently restart the 10-attempt counter on the same permanently-dead URL. A revert immediately followed by another full retry cycle that hits the cap surfaces the same row eligible for give-up again — operator-driven by design.

Pagination: 50 per section per page (URL `?page_<n>=N`). `cc_import_runs.error_summary` rendered at the top.

### 9.3 Dispatcher integration

#### A. No global suppression hook for Bucket B

Bucket B is `status='completed'`. No standard scheduler matches.

#### B. New `post_event_wrap_up_email` handler

```js
// server/utils/ccWrapUpHandler.js
function registerCcWrapUpHandler() {
  registerHandler('post_event_wrap_up_email', wrapUpHandler, {
    offsetFromEventDate: null,
    anchor: 'event_date',
    category: 'operational',
    priority: 3,
    cooldownExempt: true,
    multiChannel: false,
  });
}
module.exports = { registerCcWrapUpHandler };
```

Boot in `server/index.js`, alongside the existing handler requires:

```js
require('./utils/ccWrapUpHandler').registerCcWrapUpHandler();
```

#### C. Wrap-up email template

New file: `server/utils/ccWrapUpEmailTemplate.js`. Exports `renderCcWrapUpEmail({ client, proposal })` returning `{ subject, html, text }`.

- **Subject:** `Thanks for celebrating with Dr. Bartender, ${client.name.split(' ')[0]}` (first token of `clients.name`; falls back to `client.name` if no space).
- **Body** (wrapped in `wrapEmail` from `server/utils/emailTemplates.js:19` — the operational wrapper, deliberately omits the marketing-style unsubscribe footer; matches `review_request` template's choice at `marketingEmailTemplates.js:106-110`):
  - One-paragraph thank-you mentioning `proposal.event_date`.
  - If `process.env.PUBLIC_GOOGLE_REVIEW_URL` is set: a call-to-action button linking out.
  - Always: a link to the feedback page using the **path-segment** convention: `${process.env.PUBLIC_SITE_URL}/feedback/${proposal.token}` (matches `marketingHandlers.js:494` + `publicFeedback.js`).
  - Signoff: standard Dr. Bartender email signature.
- **From:** `Dr. Bartender <no-reply@drbartender.com>` (the standard `sendEmail` default).
- **Reply-To:** `process.env.ADMIN_EMAIL` (per CLAUDE.md's email-discipline rule).

#### D. `scheduleDrinkPlanNudge` behavior change

`server/utils/drinkPlanNudge.js scheduleDrinkPlanNudge` adds an early-return:

```js
const planRes = await exec.query(
  'SELECT 1 FROM drink_plans WHERE proposal_id = $1 LIMIT 1',
  [proposalId]
);
if (planRes.rowCount === 0) {
  return; // No drink plan exists; nothing to nudge about.
}
```

Generally correct: an event without a drink plan should never be nudged.

**Existing tests need updating** to seed a `drink_plans` row before calling the helper. Audit during plan execution — the rough list of sites that call `scheduleDrinkPlanNudge` (or `schedulePreEventReminders`, which transitively calls it) WITHOUT pre-seeding a drink plan:
- `server/utils/drinkPlanNudge.test.js` — blocks around lines 58 and 73 directly call `scheduleDrinkPlanNudge`. Tests at lines 85, 111, 141 are for the handler suppression logic and already seed `drink_plans` rows; they don't need the change.
- `server/utils/preEventScheduling.test.js` — blocks around lines 130, 158, 175 call `schedulePreEventReminders` (which calls the nudge transitively). The fix may go at the proposal-setup fixture level rather than per-test.

Each affected test's `beforeEach` / setup gets an additional `INSERT INTO drink_plans (proposal_id, token, ...) VALUES ($1, $2, ...)` before the helper call. Without this update, CI fails immediately. Plan execution should run the test suite once after the helper change to see precisely which tests break.

**Test-rewrite vs. fixture-seed distinction.** If a test EXPLICITLY asserts "scheduling fires without a drink plan" (i.e., asserts the pre-change behavior as the desired contract), that test needs a rewrite to assert the new behavior ("scheduling skips when no drink plan exists"), not just a fixture seed. The fixture-seed updates apply to tests that incidentally lacked a drink_plans row in setup but didn't care either way; the rewrite applies to tests that intentionally exercised the no-drink-plan path. Plan execution distinguishes between these by reading each failing test's assertion message.

**Re-enroll path:** if an admin creates a drink plan AFTER import (Section 12 explicitly allows this), the early-return has already fired and the SMS/email rows are absent. Spec ships BOTH approaches:

1. **Code hook (primary):** add a non-blocking call at the end of `server/utils/eventCreation.createDrinkPlan` AFTER the INSERT (the hook lives in the helper itself, which covers BOTH known callers — the webhook path via `createEventShifts:140` AND the admin route `POST /api/drink-plans/for-proposal/:proposalId` at `server/routes/drinkPlans.js:791`). Skip the hook when `createDrinkPlan` returns `null` (the helper is idempotent — returns `null` when a plan already exists for the proposal). The direct `POST /api/drink-plans` route at `server/routes/drinkPlans.js:760` does a raw `INSERT INTO drink_plans` without using the helper AND without a `proposal_id`, so a nudge would no-op there anyway via the Section 9.3.D early-return — explicitly out of scope.

   **Transaction boundary.** `createDrinkPlan` (`eventCreation.js:40-72`) uses `pool.query(...)` with no internal transaction. Two callers wrap it externally:
   - Webhook path: `createEventShifts` is called from `server/routes/stripe.js`. Verified: that path does NOT wrap `createEventShifts` in a transaction (uses bare `pool.query` calls), so the hook fires outside any active transaction.
   - Admin path: `server/routes/drinkPlans.js:780` does not wrap either.
   
   The hook is invoked with `pool` (not a client), so it runs on its own connection. A scheduling failure can't roll back the drink plan because the plan's INSERT has already committed via its own auto-committed `pool.query`.
   ```js
   // At the end of createDrinkPlan, after the INSERT (and outside its transaction so a scheduling failure can't roll the plan back):
   if (newDrinkPlan) {  // null return means plan already existed
     try {
       await scheduleDrinkPlanNudge(proposalId, pool);
     } catch (err) {
       Sentry.captureException(err, { tags: { hook: 'createDrinkPlan_reenroll', proposalId } });
       // Non-blocking; the plan persists either way.
     }
   }
   ```
   **Order safety in the native webhook flow:** `scheduleDepositPaidReminders → schedulePreEventReminders` already calls `scheduleDrinkPlanNudge` once at deposit-paid time; if a drink plan also got created mid-flow, the hook calls `scheduleDrinkPlanNudge` again. The partial-unique on `scheduled_messages(...) WHERE status='pending'` makes the second call a no-op. No duplicates.

2. **Operator step (fallback):** event detail page gets a "Schedule drink-plan nudges" button (visible only when `cc_id IS NOT NULL` AND a drink_plans row exists). Endpoint:

   ```
   POST /api/admin/proposals/:id/reenroll-drink-plan-nudge
   Auth: auth + requireAdminOrManager
   Body: {} (none)
   Validation: :id is a valid integer; proposal exists; drink_plans row exists for proposal_id. NotFoundError on missing.
   Action: await scheduleDrinkPlanNudge(proposal.id, pool);
   Response: 200 { scheduled: <int>, message: 'Drink-plan nudges scheduled (or already pending)' }
   Audit: logAdminAction({ actorUserId: req.user.id, targetUserId: proposal.client_id, action: 'cc_drink_plan_nudge_reenrolled', metadata: { proposal_id, cc_id } })
   ```

**Pre-existing bug to NOT inherit:** `drinkPlanNudge.js:147,159` builds the nudge URL as `${PUBLIC_SITE_URL}/plan/${ctx.token}` using `proposal.token`, but `routes/drinkPlans.js:124` looks up `WHERE dp.token = $1` (drink_plans token). This native bug pre-dates the import; should be fixed during plan execution (not in spec scope) so the import doesn't inherit it.

#### E. Legacy-stub guards on the three payroll-write paths

The actual functions and their real signatures (verified against the codebase):

- `server/utils/payrollAccrual.js accruePayoutsForProposal(proposalId)` — operates per-proposal.
- `server/utils/payrollLateTip.js rollForwardLateTip(tipId)` — operates per-tip; the tip's recipient is `tips.target_user_id` (and the shift via `tips.shift_id`).
- `server/utils/payrollClawback.js clawbackTip(tipId, newCumulativeRefundedCents)` AND `clawbackTipByPaymentIntent(paymentIntentId, newCumulativeCents)` — operate per-tip; `clawbackTipByPaymentIntent` internally calls `clawbackTip` so the guard inserted in `clawbackTip` covers both.

Two helpers in a new `server/utils/payrollGuards.js`:

```js
const { pool } = require('../db');

// Per-proposal: ANY participating user is a legacy stub → skip accrual entirely.
async function isLegacyCcParticipant(proposalId, client = pool) {
  const r = await client.query(
    `SELECT 1 FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       JOIN users u  ON u.id = sr.user_id
      WHERE s.proposal_id = $1
        AND sr.status = 'approved'
        AND u.cc_id LIKE 'legacy_cc:%'
      LIMIT 1`,
    [proposalId]
  );
  return r.rowCount > 0;
}

// Per-user: target_user_id is a legacy stub → skip the tip/clawback.
async function isLegacyCcStubUser(userId, client = pool) {
  if (!Number.isInteger(userId)) return false;
  const r = await client.query(
    `SELECT 1 FROM users WHERE id = $1 AND cc_id LIKE 'legacy_cc:%' LIMIT 1`,
    [userId]
  );
  return r.rowCount > 0;
}

module.exports = { isLegacyCcParticipant, isLegacyCcStubUser };
```

Wired into each function:

- **`accruePayoutsForProposal(proposalId)`** — at the top, after the proposal lookup:
  ```js
  if (await isLegacyCcParticipant(proposalId)) {
    console.log(`[payrollAccrual] proposal #${proposalId} has legacy CC stub participants; skipping accrual.`);
    return { skipped: true, reason: 'legacy_cc_stub_participant' };
  }
  ```

  **Return-shape normalization** — the existing `accruePayoutsForProposal` (`server/utils/payrollAccrual.js:55`) returns `undefined` on success and on its existing non-`completed` early-return at line 65. To make the `/reaccrue-payout` endpoint's contract coherent, also update those two paths to return structured shapes:
  ```js
  // Existing early-return for non-completed proposals (line 65):
  if (proposal.status !== 'completed') {
    return { skipped: true, reason: 'not_completed', status: proposal.status };
  }
  // ... existing accrual logic ...
  return { skipped: false, accrued: payoutsCreatedCount };
  ```
  This widens the helper's contract but doesn't break any current caller (the auto-completion path at `balanceScheduler.js:228` doesn't inspect the return). All three shapes (`{ skipped: true, reason: 'legacy_cc_stub_participant' }`, `{ skipped: true, reason: 'not_completed', status }`, `{ skipped: false, accrued: N }`) become consumable by the new `/reaccrue-payout` endpoint.

  **UI operator copy per return shape** (the wrap-up / Review page button surfaces these):
  - `{ skipped: true, reason: 'legacy_cc_stub_participant' }` → toast: *"Still blocked — another stub user participates on this proposal. Link it on the CC Import Review page first."*
  - `{ skipped: true, reason: 'not_completed', status: '<s>' }` → toast: *"Skipped — proposal is `<status>`, not `completed`. Payout accrual runs on event completion."*
  - `{ skipped: false, accrued: N }` → toast: *"Accrued N payout rows."* (use plural rules for N=0/1/many)

- **`rollForwardLateTip(tipId)`** — both `payrollLateTip.js:25-29`'s and `payrollClawback.js:23-27`'s tip SELECTs DO NOT currently return `target_user_id`. The guard adds it. Concretely, widen the SELECT to include `target_user_id` (already a column on `tips`), or do a single small lookup before the guard:
  ```js
  const tgtRes = await pool.query('SELECT target_user_id FROM tips WHERE id = $1', [tipId]);
  const targetUserId = tgtRes.rows[0]?.target_user_id;
  if (targetUserId && await isLegacyCcStubUser(targetUserId)) {
    Sentry.captureMessage('rollForwardLateTip: target is legacy_cc stub; skipping', {
      level: 'info',
      extra: { tipId, targetUserId },
    });
    return { skipped: true, reason: 'legacy_cc_stub_target' };
  }
  // existing rollForwardLateTip body follows
  ```
  Or, equivalently, widen the existing `SELECT id, shift_id, amount_cents, fee_cents ... FROM tips WHERE id = $1` at `payrollLateTip.js:25-29` to include `target_user_id` and read from `tipRow.target_user_id` after the lookup. Either approach is fine; spec recommends widening the existing SELECT to avoid an extra round-trip.

- **`clawbackTip(tipId, newCumulativeRefundedCents)`** — same pattern. Widen `payrollClawback.js:23-27`'s tip SELECT to include `target_user_id`, then guard at the top of the function. `clawbackTipByPaymentIntent` (`payrollClawback.js:157`) calls `clawbackTip` internally, so the guard inherits automatically.

**Structured skip surfaces to callers.** All three functions return `{ skipped: true, reason: <string> }` instead of silently no-op-ing. Callers (the admin routes that trigger these, e.g., a manual late-tip reconciliation flow) inspect `result.skipped` and surface a UI message: *"Skipped — recipient is a legacy CC stub user. Link the stub to a real user via the CC Import Review page first."*

**Re-trigger path:** the previous rev's "Re-accrue payouts" button was wired to query `shift_requests WHERE user_id = $now_real_user_id`, but the `/unmatched-payee/.../link` action only updates `legacy_cc_payouts.payee_user_id` — it never touches `shift_requests.user_id`, so the now-real user has no `shift_requests` rows for any historic CC proposal and the button is always empty. Fix: the link action ALSO reassigns the stub's `shift_requests.user_id` to the now-real user across every shift the stub participated in. **Dedup first to avoid `UNIQUE(shift_id, user_id)` collision** (`schema.sql:304`): if the now-real user is already an approved request on any shift the stub also worked (e.g., the operator confirmed the real user natively on a Bucket A shift that also has the stub assigned), the UPDATE would throw and roll back the whole transaction.

```sql
-- Inside the /unmatched-payee/:legacy_payout_id/link transaction, after the legacy_cc_payouts.payee_user_id UPDATE:

-- Step 1: drop stub rows ONLY when the now-real user is ALREADY 'approved' on the same shift.
--         (If the now-real user's existing row is 'pending' or 'denied', we instead drop THAT row and let the stub's
--          'approved' row reassign in step 2 — preserves the historic event's approved-staffing record, which
--          payrollAccrual.accruePayoutsForProposal counts on.)
-- Step 1a: drop now-real user's non-approved rows where the stub has the approved one (preserve money path).
DELETE FROM shift_requests sr
 WHERE sr.user_id = $now_real_user_id
   AND sr.status IN ('pending', 'denied')
   AND EXISTS (
     SELECT 1 FROM shift_requests sr2
      WHERE sr2.shift_id = sr.shift_id
        AND sr2.user_id = $stub_user_id
        AND sr2.status = 'approved'
   );
-- Step 1b: drop stub rows where the now-real user is ALREADY approved (genuine duplicate; no money loss).
DELETE FROM shift_requests sr
 WHERE sr.user_id = $stub_user_id
   AND EXISTS (
     SELECT 1 FROM shift_requests sr2
      WHERE sr2.shift_id = sr.shift_id
        AND sr2.user_id = $now_real_user_id
        AND sr2.status = 'approved'
   );

-- Step 2: reassign the remaining stub rows — guaranteed not to collide because steps 1a/1b cleared all conflicts.
UPDATE shift_requests
   SET user_id = $now_real_user_id
 WHERE user_id = $stub_user_id;

-- Step 3: capture the inherited proposal ids for the auto-reaccrue at the end of the transaction.
-- (Pulled into a JS variable; the inherited shifts → proposals list drives both the modal copy and
--  the auto-reaccrue loop below.)
WITH inherited_proposals AS (
  SELECT DISTINCT s.proposal_id
    FROM shift_requests sr
    JOIN shifts s ON s.id = sr.shift_id
   WHERE sr.user_id = $now_real_user_id
     AND sr.status = 'approved'
)
SELECT proposal_id FROM inherited_proposals;

-- Stub is now orphaned (no shift_requests, no legacy_cc_payouts pointing at it).
-- It stays in users (deactivated) for audit trail; do NOT delete.

COMMIT;  -- the link transaction ends here.
```

**Step 4 — Post-COMMIT auto-reaccrue (best-effort, NOT atomic with the link).** Inside the link transaction, the UPDATEs are uncommitted. `accruePayoutsForProposal` uses its own `pool.connect()` (a separate connection) and runs under READ COMMITTED isolation, so calling it before COMMIT would read a stale snapshot — `isLegacyCcParticipant` would still see the stub on the now-reassigned shifts, the guard would fire, and accrual would skip. The exact solo-stub case this exists to handle would silently fail. Fix: run accrual AFTER COMMIT, fire-and-forget per proposal:

```js
// After the link transaction COMMITs successfully:
const inheritedProposalIds = /* captured during step 3 inside the txn */;
for (const proposalId of inheritedProposalIds) {
  try {
    await accruePayoutsForProposal(proposalId);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: '/unmatched-payee/.../link', step: 'auto_reaccrue' },
      extra: { proposalId, stubUserId, nowRealUserId },
    });
    // Don't re-throw — the link itself succeeded; the manual "Re-accrue payouts"
    // button on the user-detail page is the operator's fallback.
  }
}
```

This is intentionally best-effort: the link is the irreversible operator decision; accrual is a derived calculation that can be retried. If the loop fails for some proposals, the operator hits the user-detail "Re-accrue payouts" button to retry — that endpoint runs after the link is fully committed and sees the correct post-reassignment state.

**Audit trail.** After step 1a + 1b run (inside the link transaction), write one `proposal_activity_log` entry per affected proposal recording which rows were deleted: `action = 'cc_link_shift_request_dedup', details = {"stub_user_id": ..., "now_real_user_id": ..., "deleted_rows": [{shift_id, was_user_id, was_status}, ...]}`. COMMIT is irreversible; the audit trail is the only path to reconstruct what the stub had been doing.

**Scope is intentional and global to the stub.** A stub is per-(payee-name + first-paid-on hash) = "one human," so reassigning ALL of that human's historic shifts to the now-real user is correct semantics, not a bug. The UI should confirm before the operator commits:

> "Linking <stub display name> → <real user name> will reassign **X shifts**, merge **Y duplicates** (real user already approved), and clear **Z denial/pending rows** (real user's previous status replaced with the stub's approved record) across **M proposals**. Confirm?"

Modal copy pluralization rules:
- When `X == 0 AND Y == 0 AND Z == 0` (payouts-only stub with no shift_requests): "will reassign 0 shifts (this user only had historic payouts, no event participation) across 0 proposals."
- When `Z == 0`: drop the `, and clear 0 denial/pending rows (...)` clause entirely.
- When `Y == 0`: drop the `, merge 0 duplicates (...)` clause entirely.
- When any count is 1: singular form ("1 shift", "1 duplicate", "1 denial/pending row", "1 proposal").

The counts come from a precheck query (separate GET endpoint, `GET /api/admin/cc-import/review/unmatched-payee/:legacy_payout_id/link-preview?user_id=<n>`):

```sql
SELECT
  COUNT(*) FILTER (
    WHERE NOT EXISTS (
      SELECT 1 FROM shift_requests sr2
       WHERE sr2.shift_id = sr.shift_id AND sr2.user_id = $now_real_user_id
    )
  ) AS shifts_reassigned,
  COUNT(*) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM shift_requests sr2
       WHERE sr2.shift_id = sr.shift_id AND sr2.user_id = $now_real_user_id AND sr2.status = 'approved'
    )
  ) AS shifts_merged,
  COUNT(*) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM shift_requests sr2
       WHERE sr2.shift_id = sr.shift_id AND sr2.user_id = $now_real_user_id AND sr2.status IN ('pending', 'denied')
    )
  ) AS shifts_real_user_status_cleared,
  COUNT(DISTINCT s.proposal_id) AS proposals
FROM shift_requests sr
JOIN shifts s ON s.id = sr.shift_id
WHERE sr.user_id = $stub_user_id;
```

For a payouts-only stub with no shift_requests (Phase 5 created a stub from `report (5).csv` with no matching CC event in `report (10).csv`), all three counts read 0 and the modal copy gracefully says "will reassign 0 shifts (this user only had historic payouts, no event participation)" — operator confirms the link still applies to the `legacy_cc_payouts.payee_user_id` reassignment alone.

After the reassignment, the now-real user has the stub's shift_requests (minus collisions), and the "Re-accrue payouts" button query (below) finds them. Operator sees the button immediately after clicking link.

```
POST /api/admin/proposals/:id/reaccrue-payout
Auth: auth + requireAdminOrManager
Body: {} (none)
Validation: :id is a valid integer; proposal exists. NotFoundError on missing.
Action: await accruePayoutsForProposal(proposal.id);  // now passes the guard because the participant is no longer a stub
Response: 200 { result: <result> }  // returns the helper's full result including { skipped: ..., accrued: ... }
Audit: logAdminAction({ actorUserId: req.user.id, targetUserId: <proposal.client_id is OK; the action is proposal-scoped>, action: 'cc_payout_reaccrued', metadata: { proposal_id, cc_id } })
```

Operator-visible affordance: a "Re-accrue payouts" button on the user-detail page (visible to admin+manager). The button query is **"proposals that this user is a participant on AND that have any other participant with `cc_id LIKE 'legacy_cc:%'`"** — i.e., proposals where the stub-guard would have previously fired. Concretely:

```sql
SELECT DISTINCT s.proposal_id
  FROM shift_requests sr
  JOIN shifts s ON s.id = sr.shift_id
 WHERE sr.user_id = $now_real_user_id
   AND sr.status = 'approved'
   AND EXISTS (
     SELECT 1 FROM shift_requests sr2
       JOIN users u ON u.id = sr2.user_id
      WHERE sr2.shift_id IN (SELECT id FROM shifts WHERE proposal_id = s.proposal_id)
        AND u.cc_id LIKE 'legacy_cc:%'
   );
```

Clicking re-accrues each — they all now pass the participant guard because at least one stub has been replaced with the now-real user.

**Hot-path index check.** `isLegacyCcParticipant` runs on every accrual. Required indexes (verify exist or add during implementation): `shifts(proposal_id)`, `shift_requests(shift_id, status)`, `users(cc_id) WHERE cc_id IS NOT NULL` (Section 6.6 already adds this). The query plan should be a 3-way nested-loop with index lookups, not a sequential scan.

#### F. `SKIP_REANCHOR_TYPES` in `rescheduleProposal.js` (defense-in-depth)

```js
const SKIP_REANCHOR_TYPES = new Set(['post_event_wrap_up_email']);

// inside the per-row loop in reanchorPendingMessages:
if (SKIP_REANCHOR_TYPES.has(row.message_type)) continue;
```

**Status: belt-and-suspenders, not gap-fix.** `reanchorPendingMessages` (`rescheduleProposal.js:111-150`) already skips message types where `offsetFromEventDate === null` via the `if (!newScheduledFor) continue;` branch (line 143-146). The wrap-up handler registers with `offsetFromEventDate: null`, so it's already skipped under existing behavior. The explicit set is defensive against a future bug where someone changes the handler's offset without remembering the implication for the reanchor pass.

## 10. Idempotency & rerunnability

- **Raw layer:** `UNIQUE (source_file, source_row_number)`. `source_row_hash` detects content changes across re-exports; on detection, row updated in place + `cc_import_runs.notes` JSON entry records the diff.
- **Archive layer:** PK or UNIQUE(`raw_import_id`).
- **Native layer:** partial-unique `ON CONFLICT (cc_id) WHERE cc_id IS NOT NULL DO ...` on `clients`/`proposals`/`users`. Proposals use `DO NOTHING`.
- **Payments:** dual partial unique on `proposal_payments(proposal_id, legacy_charge_id)` + `proposal_payments(legacy_charge_id)`. Non-Stripe rows: explicit SELECT-then-skip on `promoted_payment_id IS NOT NULL` (Section 8.4 step 4).
- **Refunds:** explicit SELECT-then-skip on `promoted_refund_id IS NOT NULL` (Section 8.4 step 5). Manual-Stripe-reconciliation rows tagged with `proposal_refunds.reason LIKE 'Manual Stripe reconciliation%'` are detected and skipped (don't double-count).
- **`amount_paid` recompute:** sums from scratch each Phase 4 run.

Run log:

```sql
CREATE TABLE IF NOT EXISTS cc_import_runs (
  id SERIAL PRIMARY KEY,
  phase INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'failed', 'partial')),
  rows_processed INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  rows_skipped  INTEGER NOT NULL DEFAULT 0,
  rows_errored  INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,
  notes JSONB NOT NULL DEFAULT '[]'
);
```

## 11. Error handling

- **CSV parse:** abort phase, log + reason. Resume next run.
- **Per-row inside a batch:** SAVEPOINT per row. Failed row rolls back, writes `import_status = 'errored'`, batch continues.
- **Stripe charge id:** in `legacy_charge_id`, NEVER `stripe_payment_intent_id`. Column comment + insert-site comment warn.
- **Refunding legacy charges via DRB OS:** the existing refund route (`server/routes/stripe.js:594`) filters on `stripe_payment_intent_id IS NOT NULL`, so the admin "Refund" button on a Bucket B proposal with only legacy payments shows "no refundable payments." A read-only **"Legacy CC payments (manual Stripe refund required)"** section on the proposal payment panel surfaces those rows so admin understands the proposal isn't payment-less. **Gated to `auth + adminOnly`** (not `requireAdminOrManager`) — exposing raw Stripe charge ids to managers widens what a manager could do with Stripe support claiming to act on the business's behalf.
- **Manual Stripe reconciliation:** any refund of an imported CC payment must be done directly in the Stripe dashboard against `legacy_charge_id`, then a manual `proposal_refunds` row recorded via a one-off SQL or admin tool with `reason LIKE 'Manual Stripe reconciliation%'`. The reason-prefix is the marker that lets Phase 4 step 5 skip re-import on the next CC re-export, preventing double-counting.
- **R2 download failures (Phase 0):** persisted to `cc_import_phase0_failures`. Max 10 attempts before surfacing on the Review page for operator "Accept loss" action (Section 9.2 §7).
- **Phase 1 per-user transaction:** spec'd in 8.1 step 3 — multi-table fan-out wrapped in BEGIN/COMMIT; partial failure rolls back the user, batch continues.
- **Sentry — aggregated per phase.** Each phase emits ONE summary `Sentry.captureMessage` with `extra: { phase, errored_count, samples: first_5 }`. Genuine infra failures (DB connection lost, R2 5xx, encryption-key missing) still emit per-incident exceptions.

## 12. What we accept losing

- **Refund reason text** — all 13 imported refunds carry `reason = 'Legacy Check Cherry import — refund reason not exported'`.
- **Stripe refund ids and refund dates** — CC export omits them; `proposal_refunds.stripe_refund_id` is NULL for imported refunds. Future reconciliation against Stripe keys off `legacy_charge_id` manually.
- **Email and SMS conversation history.**
- **Signed contract PDFs en masse.**
- **Drink plans** — no `drink_plans` row created. Section 9.3.D's behavior change makes the nudge a no-op for any plan-less event; option 2 (auto-re-enroll on later admin-create) restores native behavior if the operator manually creates one.
- **Payroll gratuity for imported events.** CC's `report (10).csv` does not expose a per-event gratuity figure. The Bucket A/B `pricing_snapshot` is therefore written with `breakdown: []`, and `extractGratuityCents` (`server/utils/payrollMath.js:41-50`) returns 0 for any imported event. Consequences:
  - **Bucket B** (past, `status='completed'`): `accruePayoutsForProposal` never fires for these (status filter at `balanceScheduler.js:188`), so no payroll consequence. CC's prior payroll system already paid out historic gratuity out-of-band; the legacy `report (5).csv` payouts archive (Section 6.4) preserves that record.
  - **Bucket A** (future, naturally auto-completes when its date passes): `accruePayoutsForProposal` DOES fire. Bartenders correctly accrue hourly pay from `contractor_profiles.hourly_rate`. The gratuity slice is $0 — operator manually creates payout adjustments via the existing admin payroll UI if a Bucket A event's gratuity needs to be paid out to bartenders.
  - Documenting here so the operator and a future maintainer don't mistake this for a bug. Fix is out of scope for the import (would require CC-side gratuity discovery — not in the export).
- **Shopping lists, post-event feedback rows, tip records.**
- **CC's UTM/marketing attribution per booked event** — present on leads file only.

## 13. Financial dashboard impact

Bucket A and B become native rows. With `cc_id`, `accepted_at`, `sent_at`, payment `created_at`, and refunds populated correctly, every existing rollup includes legacy data without code changes.

**New filter chip — `?include_cc=<all|exclude|only>`** (default `'all'`):

| Value | SQL effect |
|---|---|
| `'all'` | No additional WHERE clause |
| `'exclude'` | `AND p.cc_id IS NULL` |
| `'only'` | `AND p.cc_id IS NOT NULL` |

**Server touchpoints:**
- `server/utils/metricsQueries.js` — the 8 `qX` helpers that accept `f` get a new `f.includeCc` field. `qPipelineOutstanding` and `qPaidCount` don't take `f` and aren't changed.
- `qMoney(basis='paid')` and `qRevenue(basis='paid')` currently query `proposal_payments` without a JOIN to `proposals`. Add `JOIN proposals p ON p.id = pp.proposal_id` to the paid-lens branch when `includeCc !== 'all'`, plus the filter.
- `server/routes/proposals/metadata.js` — reads `?include_cc=` and threads to each helper.

**Client touchpoints:**
- `client/src/hooks/useMetricsFilter.js` — add `includeCc`.
- `client/src/components/adminos/MetricsFilterBar.js` — tri-state segmented control. Verify the current prop API before adding the chip (don't break existing controls).

**Tests:**
- Unit test per `qX` helper asserting all three modes.
- Integration test asserting `all_total == exclude_total + only_total` for a representative month.

## 14. Sunset criteria

Check Cherry + Wix forms cancellable once ALL of:

1. Every phase reports `succeeded` in `cc_import_runs`.
2. Review page sections 1–7 all empty OR every row actioned.
3. Bartending-Services false-skip check: Section 9.2 §6 (Skipped) reviewed; any false-skip promoted.
4. Manual spot-check: 10 random events from each bucket verified against CC source.
5. Financial reconciliation (refund-aware):
   ```sql
   SELECT date_trunc('month', p.event_date)::date AS month,
          SUM(p.total_price)::numeric AS gross_post_refund,
          SUM(p.amount_paid)::numeric AS paid_net,
          COALESCE(SUM(r.amount) FILTER (WHERE r.status='succeeded'), 0)::numeric / 100.0 AS refunded
     FROM proposals p
LEFT JOIN proposal_refunds r ON r.proposal_id = p.id
    WHERE p.status IN ('completed','confirmed','balance_paid')
      AND p.event_date >= date_trunc('month', NOW()) - INTERVAL '3 months'
      AND p.event_date <  date_trunc('month', NOW())
 GROUP BY 1 ORDER BY 1;
   ```
   `gross_post_refund` is already net of contract refunds (Phase 4 step 5). CC-side comparison via spreadsheet pivot. Within $1/month tolerance.
6. `cc_import_phase0_failures` has every row either `resolved_at IS NOT NULL` OR `given_up_at IS NOT NULL`.
7. 7-day quiet period with no operator complaints.

After: CC read-only-cancel-eligible. Wix forms taken down once Phase 1 verification (80 contractors visible, 40 payment-info present) is complete.

### 14.1 Runbook during the 30-day CC sunset window

The CC subscription stays active for ~30 days after the initial import to absorb residual activity (CC-side payments for events booked through CC, occasional fallback bookings). The operator re-downloads the canonical CSVs and re-runs the importer as needed — typically weekly, or whenever a meaningful CC-side change occurs. From a terminal session:

```bash
# After dropping fresh report (10).csv / report (11).csv / report (5).csv into C:\Users\dalla\Downloads\:
node scripts/cc-import.js --phase=4    # most common: pick up new payments
node scripts/cc-import.js --phase=3    # if new Confirmed events landed in CC
node scripts/cc-import.js --phase=5    # if new payouts were processed in CC
node scripts/cc-import.js --all        # safe wholesale re-run; idempotency keeps it cheap
```

Each re-run produces a new `cc_import_runs` row; the Review page reflects any new orphan/errored rows.

**Manual-entry collision discipline.** During the window, do NOT manually record CC payments in DRB OS via the standard "Record Payment" flow — wait for the next importer run to pick them up. The reason: a manually-entered row lands in `proposal_payments` with `legacy_charge_id = NULL`, so the importer's `ON CONFLICT (proposal_id, legacy_charge_id) WHERE legacy_charge_id IS NOT NULL` dedup doesn't match the legacy charge when CC's CSV next exports it — a duplicate gets inserted. If an urgent manual entry is unavoidable, set `legacy_charge_id` directly on the manual row (via psql or a one-off admin tool) BEFORE the next importer run so dedup catches it.

Sunset criterion #1 (every phase reports `succeeded`) and #2 (Review page empty) implicitly require that the final re-run produces no new actionable rows.

## 15. Mandatory documentation updates

**`README.md`:**

- Folder structure tree additions:
  - `scripts/cc-import.js`
  - `scripts/cc-import/` (lib: `csv.js`, `buckets.js`, `phases/phase0.js`…`phase6.js`)
  - `server/routes/admin/ccImport/` (`index.js`, `wrapUp.js`, `review.js`, `search.js`)
  - `server/utils/ccWrapUpHandler.js`
  - `server/utils/ccWrapUpEmailTemplate.js`
  - `server/utils/payrollGuards.js` (new shared helper for `isLegacyCcParticipant`)
  - `client/src/pages/admin/CcImportWrapUpPage.js`
  - `client/src/pages/admin/CcImportReviewPage.js`
- NPM Scripts table: add any `cc-import:*` shorthand wrappers.
- Tech Stack list: add `csv-parse`.

**`ARCHITECTURE.md`:**

- Database Schema:
  - 6 new tables.
  - New columns: `cc_id` on `clients`/`proposals`/`users`; `legacy_charge_id` + `payment_method` on `proposal_payments`; `notes` + `dismissed_at` on `legacy_cc_payments`; `given_up_at` + `given_up_reason` on `cc_import_phase0_failures`.
- API route table — all the new endpoints from Section 9:
  - `GET /api/admin/cc-import/wrap-up`
  - `POST /api/admin/cc-import/wrap-up/enqueue`
  - `GET /api/admin/cc-import/review`
  - `POST /api/admin/cc-import/review/duplicate/:row_id/confirm`
  - `POST /api/admin/cc-import/review/duplicate/:row_id/promote`
  - `POST /api/admin/cc-import/review/orphan-payment/:legacy_id/link`
  - `POST /api/admin/cc-import/review/orphan-payment/:legacy_id/dismiss`
  - `GET  /api/admin/cc-import/review/unmatched-payee/:legacy_payout_id/link-preview?user_id=<n>` (precheck counts for the confirmation modal)
  - `POST /api/admin/cc-import/review/unmatched-payee/:legacy_payout_id/link`
  - `POST /api/admin/cc-import/review/unmatched-payee/:legacy_payout_id/create-stub`
  - `POST /api/admin/cc-import/review/errored-row/:row_id/retry`
  - `POST /api/admin/cc-import/review/skipped-event/:row_id/promote`
  - `POST /api/admin/cc-import/review/phase0-failure/:row_id/accept-loss`
  - `POST /api/admin/cc-import/review/phase0-failure/:row_id/revert-give-up`
  - `GET /api/admin/cc-import/search/proposals`
  - `GET /api/admin/cc-import/search/users`
  - `POST /api/admin/proposals/:id/reenroll-drink-plan-nudge` (Section 9.3.D fallback affordance)
  - `POST /api/admin/proposals/:id/reaccrue-payout` (Section 9.3.E re-trigger affordance)
- Dispatcher handler list: `post_event_wrap_up_email`.
- Behavior changes section:
  - `scheduleDrinkPlanNudge` early-returns when no `drink_plans` row exists for the proposal.
  - `createDrinkPlan` (in `eventCreation.js` and any other entry point) calls `scheduleDrinkPlanNudge(proposalId, pool)` post-INSERT (when a new plan was actually created), wrapped in try/catch + Sentry, outside the plan's transaction.
  - `accruePayoutsForProposal` skips when any participating user has `cc_id LIKE 'legacy_cc:%'` (via `isLegacyCcParticipant`).
  - `rollForwardLateTip` and `clawbackTip` (+ `clawbackTipByPaymentIntent` by inheritance) skip when the tip's `target_user_id` has `cc_id LIKE 'legacy_cc:%'` (via `isLegacyCcStubUser`).
  - All three legacy-stub guards return `{ skipped: true, reason: <string> }` so callers can surface a UI message.
- Test updates required (Section 9.3.D): seed `drink_plans` rows in `drinkPlanNudge.test.js` and `preEventScheduling.test.js` setup.
- Third-Party Integrations: nothing new.

**`CLAUDE.md`:** no changes.

**UI affordances and frontend files (added to README or ARCHITECTURE's UI section):**
- Admin staff list "Legacy CC stub (deactivated)" badge for `users.cc_id LIKE 'legacy_cc:%' AND onboarding_status = 'deactivated'`. Raw email hidden from managers (`auth + adminOnly` only).
- Proposal payment panel "Legacy CC payments (manual Stripe refund required)" read-only section when any `proposal_payments.legacy_charge_id IS NOT NULL`. **Gated to `auth + adminOnly`** (not `requireAdminOrManager`). New frontend component: `client/src/components/admin/LegacyCcPaymentsPanel.js` rendered conditionally inside the existing payment-panel area of `client/src/pages/admin/ProposalDetail.js` and `client/src/pages/admin/EventDetailPage.js`.
- Event detail page "Schedule drink-plan nudges" button (the option-2 fallback path in Section 9.3.D), rendered when `cc_id IS NOT NULL` AND a drink_plans row exists. Lives in `client/src/pages/admin/EventDetailPage.js`.
- User detail page "Re-accrue payouts" button (the Section 9.3.E re-trigger path), rendered when the queried "stub-co-participated proposals" list is non-empty. Lives in `client/src/pages/admin/UserDetail.js` (or wherever the admin user-detail page actually lives — verify during plan execution).
- Wrap-up worklist URL state (`?page=N&filter=<...>&range=<...>`).

**Code comments (load-bearing):**
- `proposal_payments.legacy_charge_id` COMMENT (Section 6.6).
- `proposal_payments.payment_method` COMMENT (Section 6.6).
- `legacy_cc_payments.notes` and `dismissed_at` purpose comments (Section 6.3).
- `proposal_refunds.payment_id` insert site — comment explaining why legacy-imported rows leave it NULL ("CC export doesn't link refund → payment; manual reconciliation if needed").
- Phase 4 step 4 `created_at` override note (Section 8.4).
- Phase 4 step 5 refund handling citing `refundHelpers.js:118-264` Approach A + the status-demote + autopay clear (Section 8.4).
- Bucket B promotion explaining why no scheduler is called (Section 9.3.A).
- Direct-INSERT shifts site explaining why the importer doesn't reuse `createEventShifts` (Section 8.3).
- `scheduleDrinkPlanNudge` early-return citing Section 9.3.D (and the cc-import + pre-existing-URL-bug context).
- `accruePayoutsForProposal` / `rollForwardLateTip` / `clawbackTip` legacy-stub guards citing Section 9.3.E.
- `legacy_cc_payments.notes` field — `'Operator note set by /orphan-payment/:legacy_id/dismiss action.'`
- `cc_import_phase0_failures.given_up_at` — `'Operator marked URL permanently dead via Review page; counts as resolved for sunset gate.'`
