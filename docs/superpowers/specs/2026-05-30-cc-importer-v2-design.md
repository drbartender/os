# Check Cherry Importer v2 — Design

**Date:** 2026-05-30
**Status:** Draft for review
**Supersedes the parsing layer of:** `2026-05-25-checkcherry-import-design.md` (v1). The v1 schema, admin Review page, wrap-up page, and badge components are kept. The v1 phase parsers (phase1, phase3, phase4 especially) are overhauled.

---

## 1. Why this exists

The v1 importer ran against the live production database and produced visible, client-facing errors. Real clients received invoices for the wrong amount and called to complain. This document is the corrective rebuild.

Every defect below was reproduced against the actual Check Cherry export files, not assumed.

### 1.1 Confirmed defects in v1

| # | Defect | Root cause (verified) | Evidence |
|---|---|---|---|
| D1 | Event totals wrong (a paid-in-full $425 event showed $725) | Phase 3 computes `total_price = Package Amount + addons`, ignoring the real `Total Cost` column | Invoice `20260521-02`: real Total Cost `$425`, paid in full. Package-math path inflates it. |
| D2 | All guest counts default to 50 | Phase 3 reads `Estimated Number of Guests` (populated on 4 of 1244 rows) instead of `Unit Count` (populated on 1218 of 1244) | Column fill-rate scan of `report (15).csv` |
| D3 | 91 orphan payments (27% of payments unmatched) | Phase 4 matches payment to event by `(event_date, total_price)`, which is fragile and depends on the already-wrong total | `cc_import_runs` Phase 4 summary: `orphans=91` |
| D4 | Imported staff not visible, cannot request shifts | Phase 1 sets `onboarding_status` to a value outside the `/active-staff` filter set (`approved/reviewed/submitted`) | `/active-staff` handler filter vs Phase 1 insert |
| D5 | Packages not linked to existing `service_packages` | Phase 3 stores `package_name` as free text, never looks up the matching package row | Phase 3 INSERT has no `package_id` resolution |
| D6 | Staff-to-event assignments incomplete | Phase 3 matches `Assigned Staff` names by exact equality only; CC names have double spaces and variants (`"Kevin  Duffy"`) | `insertShiftRequestsForStaff` exact-match logic |
| D7 | Import sent client communications | Phase 3 enqueues balance reminders; the dispatcher then mailed real clients about wrong balances | Client complaint reports + `scheduled_messages` enqueue in Phase 3 |
| D8 | Addresses unreliable | Naive split of CC address fields; no normalization | Address-field inspection (see §7) |
| D9 | Re-running does not fix bad rows | Phase 3/4 use `ON CONFLICT DO NOTHING`, so corrected data never overwrites | INSERT conflict clauses |

### 1.2 What v1 got right (keep)

- The schema: `legacy_cc_*` tables, `cc_id` columns, `legacy_charge_id`, `payment_method`.
- `amount_paid` recompute formula: `SUM(payments) - SUM(refunds)`, tips excluded. Structurally correct; it was fed bad inputs.
- Tips handled as a separate column, never added to the event total. Matches the business rule.
- The admin Review page, wrap-up page, Legacy CC badge, and LegacyCcPaymentsPanel (the panel copy needs one correction, see §6.5).

---

## 2. Goals and non-goals

### Goals

1. Every imported event shows the correct total, amount paid, and balance, matching Check Cherry exactly.
2. Zero client communications fire as a result of the import.
3. The import is verified on a copy of production data before it touches production.
4. Imported staff are immediately visible and able to request shifts.
5. Future-dated open proposals land as live quotes the sales team can work.
6. Addresses and other free-text fields are normalized by an AI layer.
7. Re-running the import corrects existing rows rather than skipping them.
8. A single reconciliation report proves correctness, event by event.

### Non-goals

- Migrating Check Cherry's historical open-but-past proposals as live anything. They remain archived history.
- Programmatic refunds of Check Cherry era charges. Those charges live in Check Cherry's Stripe account, not ours (see §6.5).
- Re-pulling attachments (W9s, contracts) is out of scope for this pass; Phase 0 stays as-is and its failures stay on the Review page.

---

## 3. Safety model

This is the core of the rebuild. The v1 disaster happened because the importer wrote straight to live production with no dry run and with client comms enabled. The mechanisms below are specified concretely, not asserted, because "asserted but unbuilt safety" is exactly what failed in v1.

### 3.1 Neon branch dry-run (concrete mechanism)

**How the importer targets a database.** The importer reads `DATABASE_URL` only. There is no second connection path. To run against a branch, the operator sets `DATABASE_URL` to that branch's pooled connection string. The importer never hard-codes a branch or silently falls back to a default.

**Startup safety print and guard.** On boot, before any write, the importer prints and logs: the resolved host, `current_database()`, and (parsed from the host) the Neon branch identifier. It then classifies the target:

- If the host matches the known production endpoint (`ep-small-fog-adiajydo-pooler...` / the configured `CC_PROD_HOST`), the importer refuses to run unless the operator passed `--target=production` AND typed the production branch name at an interactive confirm. Any non-interactive (cron/CI) invocation against production aborts.
- If the host is any other branch, it runs after printing the one-line target banner.

This means an operator who believes they are on a branch but whose `DATABASE_URL` still points at production is stopped by the production guard, not allowed to repeat the v1 mistake.

**Branch lifecycle (commands, not prose).** The harness uses Neon's branching:

1. Create branch: `neon branches create --parent production --name cc-import-dryrun-<date>` (or the Neon MCP equivalent). Capture its pooled connection string.
2. Point the importer: set `DATABASE_URL` to that string for the run.
3. Reset between iterations: `neon branches reset cc-import-dryrun-<date> --parent` rewinds the branch to current production state in place, preserving the connection string (no URL churn). The operator re-exports `DATABASE_URL` is not required because the string is stable across a reset.
4. Discard: `neon branches delete cc-import-dryrun-<date>` when done.

The branch makes "push go" reversible: a bad run is discarded by resetting or deleting the branch, with zero effect on live data. Each dry-run iteration is reset-then-run, so re-runs start from clean production state and exercise the real dedup and matching.

**Scheduler isolation on the branch.** The importer process runs with `RUN_SCHEDULERS=false` so that no dispatcher, autopay, auto-assign, or email-sequence scheduler fires against branch data during or after the run. This closes the async-scheduler leak path (a proposal the importer creates cannot be picked up by a background scheduler mid-run).

### 3.2 Silent import (hard requirement, with real plumbing)

The importer must never cause a client-facing message to send. v1's single-flag promise was not actually wired into the indirect schedulers (`createDrinkPlan` and `schedulePreEventReminders` call `scheduleDrinkPlanNudge` unconditionally). v2 enforces silence at three independent layers so that a miss at one layer is still caught by another:

**Layer 1: the importer never calls the comms-producing helpers.** Phase 3 creates proposals, shifts, and (for quotes) proposal rows by writing directly to the tables, not by calling `createEventShifts` / `createDrinkPlan` / `schedulePreEventReminders` / `scheduleDrinkPlanNudge`. The importer owns its own INSERTs and does not route through the event-creation helpers that auto-enroll nudges. Where a helper is genuinely needed, it is called with an explicit `{ importMode: true }` option that short-circuits every `scheduled_messages` insertion inside it. The functions whose signatures gain `importMode` (and must early-return before any enqueue): `createDrinkPlan` (server/utils/eventCreation.js), `schedulePreEventReminders` (server/utils/preEventScheduling.js), `scheduleDrinkPlanNudge` (server/utils/drinkPlanNudge.js), and the balance-reminder scheduler. The importer never enqueues a wrap-up email.

**Layer 2: fail-closed boot assertion.** The importer reads `CC_IMPORT_SILENT` and refuses to start unless it is set to `required` (mirrors the Cal webhook fail-closed-when-secret-unset pattern). This guarantees no run happens with silence accidentally off.

**Layer 3: dispatcher refuses CC targets until cleared.** Independent of importer code, the scheduled-message dispatcher gains a guard: it will not send any message whose target proposal has `cc_id IS NOT NULL` unless that proposal has been explicitly cleared for outreach (`cc_comms_cleared_at IS NOT NULL`, a new nullable column set only by a deliberate admin action). So even if some unforeseen path enqueues a message against a CC proposal, the dispatcher drops it at send time. This is the belt-and-suspenders that makes silence hold regardless of import-code coverage.

**No synchronous sends either.** The silence rule covers direct sends, not just the queue. No `legacy_cc_*` import path may call `sendEmail` or `sendAndLogSms` directly. A test asserts this (grep-level and runtime).

**Enforcement tests (§16):** after a full import against a test database, zero client-facing `scheduled_messages` rows exist for CC proposals, AND no import path invoked `sendEmail`/`sendAndLogSms`, AND the dispatcher drops a synthetic message targeting an uncleared CC proposal.

### 3.3 Encryption-key preflight (prevents silent bank-PII corruption)

Phase 1 writes AES-256-GCM-encrypted bank PII (routing/account) for staff and the 116 payouts, keyed on `ENCRYPTION_KEY`. If a run uses a key that does not match the one production rows were written with, it silently writes undecryptable ciphertext that surfaces months later as failed payouts, and the reconciliation report cannot see it.

Guard: before Phase 1 writes anything, the importer reads one known-good already-encrypted row from the target database, attempts to decrypt it with the current `ENCRYPTION_KEY`, and aborts the entire run if decryption fails or returns garbage. On a fresh branch (which is a copy of production) such a row exists, so the check is always exercised. A run with a mismatched key never reaches the first write.

---

## 4. Canonical data sources

Check Cherry exports vary by saved view (column set and row filter). Multiple overlapping exports caused churn. v2 locks one canonical file per entity. The importer validates each file's header signature on load and refuses to run if the wrong file is supplied.

| Entity | Canonical file | Required columns (signature) | Notes |
|---|---|---|---|
| Events | the 97-column events export (currently `report (15).csv`) | `ID`, `Invoice Number`, `Total Cost`, `Unit Count`, `Status` | 1244 rows. Joins to payments by `Invoice Number`. |
| Payments | `report (11).csv` (or the latest, currently 341 rows) | `Paid On`, `Payment Applied`, `Invoice Number`, `Type`, `Reference Code` | Every row carries an `Invoice Number`. |
| Clients | the clients export (`report (9)` / `report (24)`) | `ID`, `Name`, `Email`, `Roles` | 1215 rows. |
| Payouts | `report (5)` / `report (25)` | `Date`, `Amount`, `Payee`, `Reference` | 116 rows. |
| Leads | the leads export (`report (12)` / `report (17)`) | `Lead Type`, `Email`, `Event Date` | |
| Invoices | `report (14)` | `Invoice Number`, `Invoice Date` | |
| Staff (Wix) | `Contractor Profile.csv`, `Payment Info.csv`, `Field Guide Acknowledgement.csv` | per file | |

### 4.1 Resolved sourcing questions

- The 1428-row events export (`report (20)` and siblings) is a different Check Cherry object type. It lacks `Invoice Number` and `Total Cost`, and includes non-events such as `Inventory` line items. It is discarded.
- By natural key (name + event date), the 97-column export is effectively a superset for real events. Exactly one future-confirmed event ("Ken Peterson, Old Town Art Fair, Beer Sampling, 2026-06-14") was found only in the 1428-row file. It is handled by hand or by a fresh full export (see Open Decision OD1).

---

## 5. Architecture

### 5.1 Two parsing tiers

The single most important architectural rule:

- **Deterministic tier** handles money, dates, IDs, invoice numbers, Stripe references, counts. Plain code, exact column reads, no AI. An LLM that is 99 percent right on a dollar amount is unacceptable.
- **AI tier** handles fuzzy human text: addresses, venue names, person names, event-type phrasing, notes cleanup. These are forgiving fields where normalization adds value and a rare miss is low-stakes and reviewable.

No money, date, count, or identifier ever passes through the AI tier.

### 5.2 Phases

The phase structure from v1 is retained. The work is in the parsers, not the orchestration.

| Phase | Entity | Major v2 changes |
|---|---|---|
| 0 | Attachments | Unchanged. |
| 1 | Staff users | Fix `onboarding_status` so imported staff are active and shift-capable (D4). |
| 2 | Clients | Add AI address normalization (D8). |
| 3 | Events | Read `Total Cost` (D1), `Unit Count` (D2), match package to `service_packages` (D5), fuzzy staff assignment (D6), silent mode (D7), future-open proposals as live quotes (§10). |
| 4 | Payments | Match by `Invoice Number` (D3), capture fees, refund handling per §6. |
| 5 | Payouts | Verification report (§12). |
| 6 | Leads, invoices | AI address normalization. |

---

## 6. Money mapping (deterministic, critical)

### 6.1 Event total

`proposals.total_price` (stored as NUMERIC dollars) comes directly from the events file `Total Cost` column. Never from package plus addons.

Verified: `Total Cost` in the events file equals `Event Total` in the payments file for the same invoice, across all sampled rows. The two sources agree, so the total is unambiguous.

No tax. Confirmed by the operator and by near-zero values in all tax columns. `Total Cost` is the full amount owed.

### 6.2 Payment matching

`proposal_payments` rows are matched to events by `Invoice Number`, replacing the v1 `(event_date, total_price)` key.

Verified: all 341 payment rows carry an `Invoice Number`; all 208 distinct payment invoice numbers match an event invoice number, with zero misses. 104 invoices carry multiple payment rows (a deposit plus a balance, typically a $100 deposit), which the invoice key handles naturally and the date-plus-total key could not.

**Schema (net-new, not "reused as-is").** Storing the CC invoice number requires a new column: `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS cc_invoice_number TEXT` (idempotent), with a non-unique index for the join. A dedicated column is chosen over a JSONB `cc_meta` blob because the Phase 4 join needs to index it and the reconciliation report needs to read it cleanly. Cross-cutting consumers to update in the same change: `server/db/schema.sql`, `ARCHITECTURE.md` Database Schema section, Phase 3 INSERT/UPSERT, the Phase 4 join, the reconciliation report (§13), and any admin proposal view that should surface the CC invoice number (the existing admin screens use the native `invoice_number_seq`; the CC number is additional, shown only on cc-imported rows).

**Payment-row upsert key (handles the 45 non-Stripe rows).** `proposal_payments` rows promoted from CC use `ON CONFLICT ... DO UPDATE`. The conflict target cannot be the v1 partial-unique `(proposal_id, legacy_charge_id) WHERE legacy_charge_id IS NOT NULL`, because the 45 cash/check/PayPal/Custom rows have a NULL `legacy_charge_id` and would never match that index, so a re-run would duplicate or silently skip them. v2 keys the upsert on the stable raw-import identity instead: a new `proposal_payments.cc_raw_import_id` column (the `legacy_cc_payments.raw_import_id` lineage), with `ON CONFLICT (cc_raw_import_id) DO UPDATE`. Every promoted payment, Stripe or not, has exactly one raw-import row, so the key is total and re-run-stable. The legacy partial-unique on `legacy_charge_id` stays as a secondary guard against double-promoting the same Stripe charge.

Phase 4 joins payment rows to proposals on the stored `cc_invoice_number`. Anything that still fails to match is set to `cc_event_id = NULL` and surfaces on the Review page orphan worklist, as today, but the expected orphan count is near zero.

### 6.3 Amount paid

`proposals.amount_paid` is recomputed after Phase 4 as `GREATEST(0, SUM(succeeded payments) - SUM(succeeded refunds))`, in cents, divided to dollars. The v1 formula is kept but **clamped at zero in the recompute itself**, not only in display. Reason: the malformed CC refunds (for example a $412.50 refund against a $350 event, §15) make the raw subtraction negative. An unclamped negative `amount_paid` would poison every downstream consumer that sums or compares it: revenue reports, balance-due lists, and the balance-reminder eligibility check (which could compute a negative balance and behave unpredictably). Clamping in `recomputeAmountPaid` keeps the stored value sane everywhere.

Downstream audit (part of this work): every reader of `proposals.amount_paid` is reviewed for the over-refund case, specifically the financial dashboard aggregates and any balance-reminder gating, to confirm none breaks when an event's refunds exceed its payments. The malformed refunds are also listed in the reconciliation report (§13) for manual follow-up.

The events file `Payments Collected` column is not used for `amount_paid`. It is a point-in-time snapshot that can lag the payments report (observed: an event showing `Payments Collected = $100` whose payments report already summed to `$650`). The payments report is the source of truth.

### 6.4 Tips and fees

- `Tip Amount` is a separate column, charged on top of the applied amount, and flows to the bartender (the payouts report). It is stored on `legacy_cc_payments.tip_cents` and never added to `total_price` or `amount_paid`. Matches the operator rule: tips are tracked once, in payouts, not duplicated into event revenue.
- `Processing Fees` are captured into `proposal_payments.fee_cents` so net revenue is reportable. `Net Amount = Payment Applied - Processing Fees` in the data.

### 6.5 Refunds and the Check Cherry Stripe account

Check Cherry created and operated its own Stripe account on the operator's behalf (`Stripe Express`). The `ch_...` charge IDs and `re_...` refund IDs in the data live in Check Cherry's Stripe, not the operator's own Stripe account.

Consequences:

1. Stored `legacy_charge_id` values are historical evidence, not actionable in the operator's Stripe dashboard.
2. The LegacyCcPaymentsPanel copy from v1 (which says "refund through the Stripe dashboard") is wrong and must be corrected to say refunds on legacy events are issued inside Check Cherry, which remains alive as a secondary system.
3. The 13 refund rows reduce `amount_paid` correctly for accounting. They are historical records.
4. Going forward, a refund on a Check Cherry era event is performed inside Check Cherry, then recorded in DRB as a manual refund entry for the books. No DRB "refund button" acts on a legacy charge.

Some CC refunds are malformed (for example a $412.50 refund on a $350 event, and refunds against $0-total events). These are imported as-is for fidelity but flagged in the reconciliation report for manual review.

### 6.6 Payment type classification

`payment_type` per payment (`deposit`, `balance`, `full`) is derived by the v1 chronological rule: first payment on an invoice is `deposit` (or `full` if it covers the whole total), subsequent payments are `balance`. With correct totals and reliable matching, this classifies correctly. Event-level `payment_type` and the `balance_paid` status re-derive from the corrected `amount_paid` versus `total_price`.

---

## 7. Event field mapping

| DRB field | CC source | Tier | Notes |
|---|---|---|---|
| `total_price` | `Total Cost` | deterministic | §6.1 |
| `guest_count` | `Unit Count` (when `Unit Name` = "Guest") | deterministic | falls back to `Estimated Number of Guests`, then NULL, never a hardcoded 50 |
| `event_date`, times | `Event Date`, `Start Time`, `End Time`, `Length` | deterministic | existing date parsing |
| `package_id` | `Package Name` matched to `service_packages.name` | deterministic with normalization | §8.3 |
| `package_name` (free text) | `Package Name` | deterministic | retained even when matched, for audit |
| `event_type` | `Event Type` | AI-assisted mapping | normalized to DRB event types with graceful fallback |
| venue fields | `Venue Name`, `Venue Full Address`, split fields | AI | §8 |
| `Assigned Staff` -> `shift_requests` | `Assigned Staff` | AI-assisted name match | §9 |
| notes | `Public Notes`, `Private Notes` | passthrough, light AI cleanup optional | preserved verbatim by default |
| `Invoice Number` (stored) | `Invoice Number` | deterministic | join key for payments |

---

## 8. AI parsing layer

### 8.1 Scope

The AI tier runs only on: street addresses, venue names, person and contact names (for matching, not for money), event-type phrasing. It never sees or emits dollar amounts, dates, counts, or identifiers.

### 8.2 Model and mechanics

- Claude API (the operator has approved paying for processing).
- Structured output: each call takes a raw CC field and returns a normalized object (for an address: street, city, state, postal, plus a confidence flag).
- Batched to control cost; addresses for all 1244 events plus 1215 clients are a bounded, one-time cost.
- Deterministic guardrail: if the AI output fails a schema or sanity check (for example an address whose ZIP does not look like a ZIP), the row keeps the raw value and is flagged for review rather than accepting a bad normalization.
- Determinism note: AI output is not bit-reproducible across runs. Because the import is idempotent (§11) and AI touches only non-money fields, a slightly different normalization on re-run is acceptable and low-stakes.

### 8.3 Package matching

`Package Name` is matched to `service_packages.name`. Roughly 82 percent of CC events name a package that exactly matches an active DRB package (for example "The Core Reaction", "The Midrange Reaction"). The matcher:

1. Tries exact name match first (deterministic).
2. For non-exact, uses a normalized comparison (case, whitespace, punctuation), then an AI-assisted fuzzy match against the known `service_packages` list, returning a `package_id` only above a confidence threshold.
3. Multi-package CC rows (comma-separated, for example "The Core Reaction, The Midrange Reaction") map to the primary package, with the full list preserved in `package_name`. Flagged in the reconciliation report.
4. No confident match leaves `package_id` NULL and `package_name` as free text. Surfaced for review.

---

## 9. Staff

### 9.1 Visibility and shift capability (D4)

Imported staff (the Wix-matched real users, not the payout-only stubs) are inserted or updated with an `onboarding_status` that passes the `/active-staff` filter and with `can_staff = true`, so they appear in the staff list and can request and be assigned to shifts immediately.

Their actual onboarding records (agreements, profile completeness) are not back-filled by this import. Bringing their stored onboarding current in DRB is tracked as separate follow-up work (OD2). The import only guarantees they are active and shift-capable now.

### 9.2 Event assignment matching (D6)

`Assigned Staff` on an event is a comma-separated free-text list (for example `"Kaitlyn  Freyer, Kevin  Duffy"`, note double spaces). v2 matches each name to a user with: whitespace and case normalization first, then an AI-assisted fuzzy match against the imported user list above a confidence threshold. A confident match creates a `shift_request` linking that user to the event's shift. An unconfident match is recorded on the Review page unmatched-staff list rather than guessed.

---

## 10. Future open proposals as live quotes

Check Cherry "Proposal (Date Open)" rows with a future event date represent active sales conversations (281 of them at last count). v2 imports these as live DRB proposals with `status = 'sent'`, so the sales team can continue working them.

- Imported with the correct client, event date, venue, package, and total.
- No auto-created shifts, no drink plan, no client comms (silent, per §3.2).
- Past-dated open proposals, canceled, expired, and postponed rows remain archived history in `legacy_cc_proposals`, not live.

This is the one genuinely new feature versus v1, which archived all open proposals.

---

## 11. Idempotency and re-runnability (D9)

Every upsert uses `ON CONFLICT ... DO UPDATE`, not `DO NOTHING`, keyed on the stable CC identifier (`cc_id` for proposals/clients, `cc_raw_import_id` for payments, raw-import hash for archive rows). Re-running the importer brings every row to match the current CSV and current parser logic. This is what makes the branch dry-run loop work: fix parser, reset branch, re-run, and existing rows are corrected, not skipped.

The specific `DO NOTHING` sites that switch to `DO UPDATE`: the Phase 3 proposal insert (`ON CONFLICT (cc_id)`), the Phase 3 `legacy_cc_proposals` archive insert, the Phase 3 `shift_requests` insert (for re-matched staff), and the Phase 4 payment promotion (re-keyed per §6.2). The raw-import inserts already use `DO UPDATE`.

### 11.1 Operator-edit preservation (do not clobber live quote work)

§10 imports 281 future-open proposals as **live quotes the sales team works**. A blind `DO UPDATE` on re-run would wipe a rep's negotiated price or status change. The upsert therefore distinguishes two field classes:

- **CC-authoritative fields, always force-overwritten on re-run:** `total_price`, `event_date`, `cc_invoice_number`, the money fields, and the package/guest fields parsed from CC. These come from Check Cherry and a re-run is meant to correct them.
- **Operator-owned fields, never overwritten once the row has moved on:** any proposal whose `status` has advanced beyond `sent` (for example `signed`, `deposit_paid`, `balance_paid`, `confirmed`, `completed`) is treated as operator-owned. For these rows the re-run updates nothing except an explicit, logged re-import the operator requests. A row still at `status='sent'` with no recorded operator edit is safe to refresh from CC.

Concretely, the re-import refreshes CC-authoritative fields only on rows still at `status='sent'`; any row whose status has advanced past `sent` is skipped for everything except an explicit, logged operator-requested re-import. The status check is the primary rule (robust, no timestamp arithmetic). A reconciliation line lists any CC row whose CSV values diverged from a skipped operator-owned proposal, so the divergence is visible rather than silent. `cc_imported_at` records the last sync time for audit only.

Money fields on still-importable rows are recomputed wholesale after each payment run (`recomputeAmountPaid` and `rederivePaymentTypeAndStatus`), so a re-run cannot leave stale partial sums.

---

## 12. Purge and rollback

A first-class CLI command (`npm run cc-import:purge`, added to `package.json` and the README NPM Scripts table) performs the verified, FK-safe deletion of all CC-imported data, in dependency order, scoped strictly to CC-created rows.

**Native-row safety.** The purge deletes only rows the import created, never pre-existing native rows. The signal is an immutable boolean `cc_import_created`, set true only in the import INSERT path and never flipped on re-run, so it cannot drift the way a timestamp comparison can. The delete predicate is `cc_import_created = true`. Any row with `cc_id IS NOT NULL AND cc_import_created = false` (a native row that dedup matched and tagged) is **untagged** (`cc_id = NULL`), never deleted, and listed in the purge report for manual attention. This guarantees a native proposal/client/payment that was tagged and later edited in production survives a purge.

**Target-DB guard (destructive-op confirmation).** Because the purge is destructive, "told which database" is not enough. The command:

1. Reads the resolved connection and runs `SELECT current_database()` plus the parsed host/branch identifier.
2. Requires the operator to pass `--target=<branch-name>` and asserts that the passed name matches the resolved branch from the live connection. A mismatch (typed `branch-foo` while `DATABASE_URL` points elsewhere) aborts before any delete.
3. If the resolved target is the production endpoint, it additionally requires `--i-understand-this-is-production` and an interactive typed confirmation of the production branch name. Non-interactive production purges abort.
4. Prints a row-count preview (how many proposals/clients/payments/users will be deleted vs untagged) and waits for a final yes before executing inside a single transaction.

This replaces the ad hoc one-off SQL used during firefighting. It is the reset step between branch dry-runs (though `neon branches reset` is preferred there) and the clean-slate option if a production run must be reversed.

---

## 13. Reconciliation report

The deliverable that earns trust. After an import run (branch or production), the importer emits a report covering:

- **Per-event money:** for every imported event, CC `Total Cost` versus imported `total_price`, CC payments sum versus imported `amount_paid`, and the resulting balance. Any mismatch beyond a cent is listed.
- **Orphans:** count and list of payments that did not match an event (target: zero).
- **Staff coverage:** events whose `Assigned Staff` did not fully resolve to users.
- **Package coverage:** events whose package did not match a `service_packages` row.
- **Malformed refunds:** the over-refund and zero-total-event cases.
- **Counts:** events by bucket (future-confirmed, past-confirmed, future-open-quote, archived), clients, staff, payouts, totals in and out.

Events with zero CC payments are expected, not mismatches: they reconcile correctly when `amount_paid = 0` and `balance = total_price`. Archived buckets (past-open, canceled) are counted but not money-reconciled, since they are history, not live proposals.

**Objective pass gate (not a freeform read).** The report ends with a machine-computed verdict, `ACCEPTABLE` or `NOT ACCEPTABLE`, so a tired operator cannot bless a partial defect. The verdict is `ACCEPTABLE` only when every one of these holds:

- Money mismatches beyond one cent: **0**.
- Unmatched (orphan) payments: **0**.
- Malformed refunds: each is explicitly marked acknowledged by the operator (the report blocks on un-acknowledged ones).
- Event counts by bucket match the Check Cherry dashboard figures the operator enters (for example "26 booked future events"): exact.
- Staff-coverage and package-coverage gaps: listed; each non-match is either resolved or explicitly accepted (the count of un-reviewed gaps must be 0 to pass).

The production cutover (§14) is permitted only when the branch report reads `ACCEPTABLE`. After the production run, the production report must read `ACCEPTABLE` and its per-event money lines must match the branch report exactly (row-by-row diff, not a vibe check). Any divergence between branch and production reports blocks the cutover sign-off.

---

## 14. Cutover procedure

1. Build and unit-test v2 in a worktree.
2. Create a Neon branch from production.
3. Run the full import against the branch.
4. Generate the reconciliation report. Review against Check Cherry.
5. Fix and repeat (reset branch from parent, re-run) until the report is clean.
6. Purge any prior CC data from production (if a partial v1 import remains).
7. Run the import against production.
8. Generate the production reconciliation report and confirm it matches the branch report.
9. Spot-check the admin UI: events, quotes, staff, a known paid-in-full event, a known multi-payment event.

No client comms are sent at any step. Sending is a later, separate decision.

---

## 15. Edge cases to handle explicitly

- Multi-payment invoices (deposit plus balance): handled by invoice-key matching.
- $0-total events with refunds: imported for fidelity, flagged.
- Over-refunds (refund exceeds total): imported, flagged, never allowed to drive `amount_paid` negative in display logic.
- Encoding artifacts in CC text (for example a stray `�` in "Old Town Art Fair"): normalized in the AI/cleanup tier; never used as a match key.
- Multi-package events: primary package linked, full list preserved.
- Cash, check, PayPal, and "Custom" processor payments (45 rows, non-Stripe): imported with `payment_method` set accordingly, no `legacy_charge_id`.
- Duplicate clients across CC and native DRB: existing dedup by email; pre-existing native rows are tagged not duplicated, and never deleted by purge.

---

## 16. Testing strategy

- Unit tests per parser using fixture rows drawn from the real CSVs (money parsing, invoice matching, guest extraction, package matching, name normalization).
- A silent-import assertion: after a full import against a test database, zero client-facing `scheduled_messages` rows exist.
- A reconciliation assertion on a seeded fixture set: known events with known payments reconcile to expected totals and balances.
- The Neon branch dry-run is the integration test against real data.

---

## 17. What is reused versus rewritten

**Reused mostly as-is:** the `legacy_cc_*` tables, admin Review page and its endpoints, wrap-up page, badge component, the `recomputeAmountPaid` shape (now clamped, §6.3), Phase 0.

**Schema additions (not "as-is" — these are new, idempotent `ADD COLUMN IF NOT EXISTS`, and each updates `ARCHITECTURE.md`):** `proposals.cc_invoice_number` (§6.2 join key), `proposals.cc_imported_at` (last-sync audit, §11.1), `proposals.cc_import_created` boolean (immutable created-by-import flag for purge safety, §12), `proposals.cc_comms_cleared_at` (§3.2 Layer 3 dispatcher guard), `proposal_payments.cc_raw_import_id` (§6.2 upsert key). The `cc_import_created` flag is added on the other import-created tables (`clients`, `users`, `proposal_payments`) too, so the purge predicate is uniform. The phase orchestration and CLI structure are reused but every phase gains the `importMode` / target-guard plumbing (§3).

**Rewritten or substantially changed:** Phase 3 (total, guests, package, staff matching, silent, quotes), Phase 4 (invoice matching, re-keyed upsert, fees), Phase 1 (staff visibility, encryption preflight). **New:** AI parsing layer, reconciliation report with pass gate, purge command with target guard, Neon branch harness, three-layer silent-import enforcement, dispatcher CC-comms guard. **Corrected:** LegacyCcPaymentsPanel refund copy (the new text: legacy charges live in Check Cherry's Stripe and are refunded inside Check Cherry, then recorded in DRB; no DRB refund button acts on them).

---

## 18. Open decisions

- **OD1 (data source):** Re-export one 97-column events report with no status or date filter, to capture the lone future event missing from the current export, or handle that one event by hand. Operator to decide.
- **OD2 (staff onboarding):** How to bring imported staff's stored onboarding current in DRB (agreements, profile) after they are made active. Separate project.
- **OD3 (AI cost ceiling):** Confirm an acceptable spend cap for the one-time address and name normalization pass. Operator approved paying; amount to confirm.
- **OD4 (quote comms):** Future-open proposals import silent. Confirm the sales team will re-engage these manually rather than expecting any automated outreach.

---

**End of design.**
