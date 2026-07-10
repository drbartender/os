# Staff Payment History Import — Design

**Date:** 2026-07-10
**Status:** Approved (brainstorm section-by-section, 2026-07-09/10)

## 1. Purpose

Import every historical staff payment (Dec 2024 → Jun 2026) from the payment
platforms Dallas actually paid people through, plus minimal staff accounts for
everyone paid, so that:

1. **Tax totals** — per-contractor calendar-year totals are correct and
   exportable for 1099-NEC season (2026 is the critical year).
2. **Earnings history** — all-time "what has this person been paid" is visible
   in the admin user page and the staff portal.

Explicitly NOT a goal: per-event fidelity for historical payments. Event
attribution is opportunistic (free evidence only). The live payroll system
(`pay_periods`/`payouts`) is the go-forward record and is untouched by this
project.

## 2. Sources (all delivered on `~/win-share/payments/`)

| Source | Format | Outgoing candidates | Notes |
|---|---|---|---|
| Chase Zelle, DRB LLC *6835 | monthly PDF ×19 | 86 / $19,324.23 | `Zelle Payment To <name> <ref-id>`; ref id = txn id |
| Venmo business (Dr. Bartending LLC) | monthly CSV ×20 | 51 / $8,820.88 | real txn ids; memos often carry staffer + event date |
| Cash App (business-used acct) | monthly PDF ×14 | 31 / $6,580.72 | `To <name> from <bank>`; no txn ids; no memos |
| Cash App personal (2nd Dallas Raby acct) | monthly PDF (New folder) | 14 / $3,461.00 | new payees incl. $1,000 Timothy Warren |
| Venmo personal (@Dallas-Raby) | monthly CSV (New folder) | 5 / $870 (~2 staff) | DIFFERENT layout: 2 title rows, combined `Datetime` col |
| Zelle, Wildsky Books *7570 | monthly PDF ×19 | 2 / $98 | rogue payments (Fareed, Michelle) |
| Chase personal *8700 | monthly PDF ×19 | 0 | clean; funding side only |
| PayPal contact@drbartender.com | Download CSV ×2 | ~15 Zul (PHP) | `General Payment` AND `Mobile Payment` types both count |
| PayPal doctorbartending@gmail.com | Download CSV | Zul (PHP) + Capleton $742 + Leech $180 | older account |
| PayPal wildskybooks@gmail.com | Download CSV ×2 | 1 Zul (PHP) | rogue |
| CC expense log (report 4) | CSV | 102 / $17,575.09, Dec 2024–Jan 2026 | **cross-check only, never primary** |
| CC contacts (report 5) | CSV | 40 staff-ish w/ email+phone | seeds people.csv contact info |
| CC bookings (report.csv) | CSV | — | event dates + assigned staff for inferred event labels |

PHP→USD: Zul's PayPal payments resolve to the USD cost via the linked
currency-conversion / bank-funding rows (shared reference txn id) in the same
export. Ledger stores USD cents only.

Dupes: business-account files appear duplicated in `New folder/` and root
(`(1)` copies); content-hash dedupe handles this mechanically.

## 3. Primary-source rule (double-count prevention)

Every physical money movement has exactly ONE primary record:

| Movement | Primary | Chase-side mirror (auto-classified `funding`, excluded) |
|---|---|---|
| Zelle | Chase statement row | — |
| Venmo | Venmo CSV row | `Orig CO Name:Venmo` ACH debits |
| Cash App | Cash App PDF row | `Cash App*<name> ... Card 6183` card rows |
| PayPal | PayPal CSV row | `Paypalsec:Web` / `Orig CO Name:Paypal` entries |
| Cash / no export evidence | CC expense row, **only with per-row user approval** (`platform='cash_other'`) | — |

Mirror rows double as a completeness check: a Chase `Cash App*`/Venmo-funding
row with no matching primary row = missing export month → flagged, never
silently dropped.

The `cash_other` approval path is concrete: CC-only rows (a CC staff-payment
expense with no matching platform row) are emitted INTO transactions.csv as
`platform='cash_other'` / `source_account='cc_expense_log'` / verdict `unsure`
(txn id = CC expense row ID); flipping the verdict to `staff-pay` is the
per-row approval. They are also listed in the coverage report.

**Supersedes `legacy_cc_payouts`.** A prior write-only table
(`legacy_cc_payouts`, loaded by `scripts/cc-ledger-import.js` from the same CC
report 4) covers overlapping dates. It has zero read consumers today and MUST
stay that way for earnings/tax surfaces: `staff_payment_history` is the single
source of historical staff pay. Never sum both.

## 4. Boundary rule (June 2, 2026)

Prod payroll state (verified 2026-07-09): 6 weekly pay periods from
2026-06-02, 10 payouts, ALL `pending`, zero `paid_at`. Therefore:

- Export rows dated **before 2026-06-02** → ledger import.
- Export rows dated **on/after 2026-06-02** → excluded from import; emitted as
  a **reconciliation report** matching each payment to a pending payout by
  person + amount. Dallas marks those paid through the payroll UI's existing
  mark-paid flow (deliberately manual — learning the system is a goal).
  Unmatched payments and still-unpaid payouts are both listed; no code writes
  to `payouts` in this project.
- **Boundary exception (post-boundary pay for pre-boundary work):** a payment
  dated on/after June 2 that matches NO payout (e.g. a June payment for May
  work — no pay period ever covered it) would otherwise vanish from every
  total. The sheet carries a `boundary_exception` column (default no); Dallas
  flips it to let that row into the ledger. Structurally enforced:
  `CHECK (paid_on < DATE '2026-06-02' OR boundary_exception)`, and
  verification asserts every exception row matches no payout (person+amount) —
  so the exception can never double-count.

A person's true total is always `sum(ledger) + sum(paid payouts)` — zero
overlap by construction, with the boundary CHECK making it structural, not
just procedural.

**Tax-year grouping is pinned:** the 1099 view groups the ledger by
`paid_on` year and payouts by `paid_at` year (constructive receipt) —
never `pay_periods.payday`.

## 5. Ledger schema

```sql
CREATE TABLE IF NOT EXISTS staff_payment_history (
  id              SERIAL PRIMARY KEY,
  contractor_id   INTEGER NOT NULL REFERENCES users(id),
  paid_on         DATE NOT NULL,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  platform        TEXT NOT NULL,      -- 'venmo'|'cashapp'|'zelle'|'ach'|'paypal'|'cash_other'
  source_account  TEXT NOT NULL,      -- 'venmo_business','cashapp_personal','chase_6835',...
  external_txn_id TEXT,               -- Venmo/Zelle/PayPal ids; NULL for PDFs without ids
  payee_handle    TEXT,               -- name/handle exactly as the platform shows it
  memo            TEXT,               -- verbatim; display only
  event_label     TEXT,               -- opportunistic attribution; plain text, NO FK
  boundary_exception BOOLEAN NOT NULL DEFAULT false,  -- §4 escape hatch
  row_fingerprint TEXT NOT NULL UNIQUE, -- txn-id based where the platform has one; positional hash otherwise
  source_file     TEXT NOT NULL,      -- provenance
  imported_at     TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT sph_before_boundary CHECK (paid_on < DATE '2026-06-02' OR boundary_exception)
);
CREATE INDEX IF NOT EXISTS idx_sph_contractor_paid_on
  ON staff_payment_history(contractor_id, paid_on);

-- companion columns on users:
--   exclude_from_1099 BOOLEAN DEFAULT false  — persisted per-person 1099 flag
--     (§8.3 view + admin toggle endpoint; import sets it from the sheet; Zul
--     defaults excluded). Admin-toggleable post-import — not set-once.
--   import_source TEXT NULL ('payment_history_import') — marks created rows
--     for the admin-list chip, audit, and the undo path; also de-overloads
--     'deactivated' vs legacy CC stubs (which key on cc_id).
```

Fingerprint rule: platforms with a real transaction id (Venmo, Zelle, PayPal)
fingerprint on `platform|txn_id` — stable across re-exports and file
reordering. Only id-less PDF rows (Cash App) use the positional
`platform|account|date|amount|payee|memo|file-seq` hash.

**Financial facts are immutable; attribution is re-runnable.** `paid_on`,
`amount_cents`, `platform` never change after import (they are the row's
identity). Re-running the import applies sheet corrections to
`contractor_id`, `event_label`, and `memo` via
`ON CONFLICT (row_fingerprint) DO UPDATE` — so a mis-clustered payee fixed in
the sheet propagates on re-run, and idempotency means "zero NEW rows", not
"no-op". No edit UI in v1; anything beyond re-attribution is a hand-written
correction script.

## 6. Minimal-user import

Per person, decided in people.csv:

- **`existing:<user_id>`** — ledger rows attach to the existing account.
- **`create-current`** — new `users` row: role `staff`,
  `onboarding_status='in_progress'`, `pre_hired=true` (same state the
  lightweight Hire path uses; pre-hire onboarding picks them up "already
  started").
- **`create-ex`** — new `users` row: `onboarding_status='deactivated'`.
  Visible in admin staff list with payment history; permanently excluded from
  active roster queries and the last-minute SMS blast (`approved`-only filter).
  **Deliberately cannot log in** (deactivated is hard-blocked at the login
  route): ex-staff history is an admin-side record. If an ex-staffer returns,
  admin flips their status through the existing lifecycle and they claim via
  forgot-password like anyone else.
- **`skip`** — agencies (Qwick), vendors, personal payees. Their rows cannot
  import as staff pay (enforcement: `contractor_id` NOT NULL).

`create-current` also seeds an `onboarding_progress` row
(`account_created=true`) — every real registration path creates one and the
onboarding UI assumes it exists.

Imported users carry `import_source='payment_history_import'` and get a small
"imported" chip in the admin staff list, so dozens of placeholder rows are
distinguishable from real onboarders at a glance.

Import pre-flight (before the transaction): every `create-*` email is checked
for uniqueness against existing `users.email` (a hit = error telling Dallas to
use `existing:<id>` instead) and within the sheet; placeholder slugs
disambiguate (`-2`, `-3`) instead of colliding — a single 23505 must not abort
the prod run.

Created rows are silent — no hire/welcome emails, no activity-feed noise.

- `users.password_hash` = bcrypt of a per-user random secret, generated and
  discarded (unclaimable by guessing). **Claim path = existing forgot-password
  flow** (proves email control, sets password, lands in onboarding). Zero new
  auth code.
- Unknown email (some ex-staff): `<name-slug>@imported.invalid` (RFC 2606
  reserved TLD) + a one-line guard in `sendEmail` refusing `.invalid`
  recipients. No self-claim until Dallas sets a real email in admin.
- `contractor_profiles`: preferred_name, phone, email (seeded from CC
  contacts).
- `payment_profiles`: `preferred_payment_method` + `payment_username` =
  platform/handle most recently used to pay them (per-person override in
  sheet). Encrypted banking fields untouched.

## 7. Pipeline (one-off scripts, `server/scripts/staffPaymentImport/`)

Data files live on the share only — **never committed** (PII).

1. **Normalize** — one parser per format (Venmo-business CSV, Venmo-personal
   CSV, Cash App PDF via pdftotext, Chase PDF via pdftotext -layout, PayPal
   CSV) → identical staging rows. Auto-classifies funding/mirror rows per §3.
2. **Classify + match** — outgoing rows only. Payee dictionary seeded from CC
   contacts, OS users, CC expense payees. Buckets: auto staff-pay (dictionary
   match), auto ignore (merchant/personal patterns: Lyft, Uber, "Massage",
   "Gift", card orders, inter-company transfers, agencies), unsure. Fuzzy
   name-clustering across platforms ("Katie Freyer"≡"Kaitlyn Freyer",
   "Chip Weinke"≡"Vernon Wienke", "Chima"≡"Chi Anderson").
   **Event matching** (fills `event_label`, best evidence wins):
   a. CC expense row match (payee+amount+date) → inherits booking label;
   b. memo parse ("Tuazon DrB 4/12", "Annah Rah - MGM");
   c. CC bookings proximity (payment within days after an event that payee
      worked) → proposed, marked inferred;
   d. none → blank (acceptable).
3. **Review sheet** — written to `~/win-share/payments/review/`:
   - `people.csv`: one row per person-cluster — proposed identity, matched OS
     account or NEW, email/phone (CC-seeded), current-vs-ex, preferred method,
     **account decision column** (§6 values), 1099 include/exclude flag
     (default: exclude Zul — foreign contractor, W-8BEN not 1099).
   - `transactions.csv`: every outgoing row — proposed person, verdict
     (staff-pay / ignore / unsure), event_label + evidence tier,
     boundary_exception (§4), incl. the `cash_other` CC-only candidates (§3).
   Dallas edits; the sheet is the sole human-judgment surface.
   **Excel-proofing:** the sheet builder also writes `.manifest.json` holding
   the canonical machine facts (fingerprint → date, amount_cents, platform,
   account, txn id, payee, memo). The import reads FACTS from the manifest and
   only the human-judgment columns (verdict, person, account decision, email,
   phone, status, preferred method, exclude flag, event_label,
   boundary_exception) from the CSV — so Excel mangling dates, +63 phone
   numbers, or long txn ids in display columns cannot corrupt the import.
   Fingerprints are prefixed `fp-` to force text cells. Human-entered
   phones/emails are normalized+validated on re-read.
   PayPal rows whose PHP→USD could not be resolved from a linked conversion
   row carry a blank amount + `unsure` verdict — they can NEVER import until
   resolved (validation rejects staff-pay rows without a positive amount); a
   raw PHP magnitude is never stored as USD.
   The coverage report also lists seeded-phone collisions (an imported
   person's phone matching an existing `approved` staffer's) — a stale CC
   phone must not shadow a real staffer in the inbound-SMS resolver.
4. **Import** — hard-validates manifest+sheets (every staff-pay row resolves
   to a person; every new person has status + email-or-placeholder; email
   uniqueness pre-flight per §6; boundary rule per §4), writes users +
   profiles + ledger in ONE transaction against prod, prints per-person
   per-year verification totals, emits the §4 reconciliation report, and
   writes a durable run log (`review/import-run-<ts>.json`: sheet checksum,
   counts created/updated/skipped, operator) since user creation is
   deliberately silent elsewhere. Re-runnable: zero NEW rows on unchanged
   input; attribution fixes propagate per §5.

Final fresh pull of CC reports 4 + 5 immediately before the run (CC dies
2026-07-21). Prod `--execute` runs in a low-traffic window.

## 8. Display surfaces (read-only; SELECTs only)

1. **Admin user detail** — historical ledger rows join the existing Payouts
   tab, platform-tagged, with an all-time blended total
   (`sum(ledger) + sum(paid payouts)`). The tab's existing hardcoded
   "1099 / tax tracking pending" placeholder card is replaced with a link to
   the §8.3 view (one 1099 surface, not two). Empty-state copy must handle
   payouts=0 + ledger>0 (the common ex-staff case).
2. **Staff portal Pay page** — same blend for the logged-in staffer
   (IDOR-scoped to `req.user.id`): blended all-time total + plain rows
   date / amount / platform. No fake paystubs, no event links, no handles.
   The page's "No pay history yet" empty state must also consider ledger
   presence — an imported current staffer with history but no OS payouts
   must not see "no history".
3. **1099 totals view** — year-picker table on the Payroll page: person ×
   year total × platform breakdown × include/exclude toggle (admin-only
   PATCH persisting `users.exclude_from_1099`, with pending/disabled state
   while in flight); CSV export. Year fields pinned per §4. January
   workflow: pick year, read column, file.

All three new fetches follow the existing inline-error-card + Retry pattern
(PayPage precedent), with loading and empty states per the house checklist.

## 9. Security / PII

- Import data + review sheets stay on the share; repo gets code only.
- No new auth surface (claim = existing forgot-password).
- `sendEmail` guard for `.invalid`.
- Ledger has no bank/handle secrets beyond what statements already show;
  `payment_handle` PII precedent from paystub project respected (staff portal
  shows platform, not other people's handles).
- Admin routes behind existing role guards.
- The `.invalid` guard covers BOTH `sendEmail` and `sendBatchEmails`
  (email.js has two independent send functions), skipping — never throwing.
- Review sheets on the share hold full contact+payment PII for ~40 people;
  Dallas confirms the share is not guest-readable and deletes the WhatsApp
  chat zip (contains EIN letter) from the share root.

## 10. Out of scope

- Editing/CRUD UI for the ledger.
- W-9 collection / TIN storage / actual 1099 filing.
- Backfilling historical payments into `pay_periods`/`payouts`.
- Any change to live payroll accrual, gratuity, or mark-paid code paths.

## 11. Verification

- Pipeline totals reconcile against per-source inventory (§2 table).
- CC expense log cross-check: every CC staff-payment row matched to a primary
  row or explicitly resolved (missing-export flag or approved `cash_other`).
- Post-import SQL spot-checks: per-person year totals vs review sheet; row
  counts; fingerprint uniqueness; no rows ≥ 2026-06-02 except flagged
  boundary exceptions, and every exception row matches no payout
  (person+amount) — the no-double-count assert.
- Re-run import → zero NEW rows (idempotency proof; attribution updates
  allowed per §5).
- Documented undo path (operator runbook): delete ledger rows by run
  (`imported_at` window / run log), deactivate created users by
  `import_source='payment_history_import'` + creation window. A bad prod run
  is recoverable without touching live payroll.
