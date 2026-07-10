---
spec: docs/superpowers/specs/2026-07-10-staff-payment-import-design.md
lanes:
  - id: spi-a-ledger
    footprint:
      - server/db/schema.sql                       # staff_payment_history table + users.exclude_from_1099 column
      - server/utils/email.js                      # .invalid recipient guard in sendEmail
      - server/utils/email.invalid.test.js         # NEW
    blockedBy: []
    review: full-fleet   # schema.sql is sensitive-listed; tiny diff, but the list is the trigger
  - id: spi-b-pipeline
    footprint:
      - server/scripts/staffPaymentImport/config.js
      - server/scripts/staffPaymentImport/staging.js
      - server/scripts/staffPaymentImport/parsers/venmoCsv.js
      - server/scripts/staffPaymentImport/parsers/cashappPdf.js
      - server/scripts/staffPaymentImport/parsers/chasePdf.js
      - server/scripts/staffPaymentImport/parsers/paypalCsv.js
      - server/scripts/staffPaymentImport/dictionary.js
      - server/scripts/staffPaymentImport/classify.js
      - server/scripts/staffPaymentImport/eventMatch.js
      - server/scripts/staffPaymentImport/exportKnownPeople.js
      - server/scripts/staffPaymentImport/buildReviewSheet.js
      - server/scripts/staffPaymentImport/__fixtures__/*    # SYNTHETIC data only — never real names/PII
      - server/scripts/staffPaymentImport/staging.test.js
      - server/scripts/staffPaymentImport/classify.test.js
      - server/scripts/staffPaymentImport/eventMatch.test.js
      - server/scripts/staffPaymentImport/buildReviewSheet.test.js
      - server/scripts/staffPaymentImport/parsers/*.test.js
    blockedBy: []
    review: standard   # offline scripts, zero prod writes, zero routes; fixture-driven tests (test files named explicitly so the glob doesn't claim spi-c's importValidation.test.js)
  - id: spi-c-import
    footprint:
      - server/scripts/staffPaymentImport/importFromSheet.js
      - server/scripts/staffPaymentImport/reconcile.js
      - server/scripts/staffPaymentImport/verifyImport.js
      - server/scripts/staffPaymentImport/importValidation.js
      - server/scripts/staffPaymentImport/importValidation.test.js
    blockedBy: [spi-a-ledger, spi-b-pipeline]   # PLUS human gate: Dallas finishes the review sheet before any prod run
    review: full-fleet + /second-opinion   # writes prod users/profiles/ledger in one transaction; money+auth adjacency outweighs "scripts aren't sensitive-listed"
  - id: spi-d-surfaces
    footprint:
      - server/routes/admin/payrollTax.js          # NEW: payment-history + tax-totals + exclude PATCH (keeps payroll.js at 611, under the soft cap)
      - server/routes/admin/index.js               # mount payrollTax
      - server/routes/admin/users.js               # staff-list SELECT adds import_source (chip data)
      - server/routes/staffPortal/payouts.js       # +GET /me/payment-history (284 lines)
      - client/src/pages/admin/StaffDashboard.js   # "imported" chip on placeholder rows
      - client/src/pages/admin/userDetail/tabs/PayoutsTab.js   # historical section + blended total + replace hardcoded 1099 card
      - client/src/pages/staff/PayPage.js          # historical section + empty-state gate fix (546 lines; +~60 OK)
      - client/src/pages/admin/payroll/PayrollPage.js          # +'tax' tab wiring (TABS + TAB_IDS + conditional)
      - client/src/pages/admin/payroll/TaxTotalsTab.js         # NEW
      - client/src/index.css
      - README.md
      - ARCHITECTURE.md
    blockedBy: [spi-a-ledger]
    review: standard   # read-only SELECTs + one admin-guarded boolean PATCH; ui-ux-review on the new tab
---

# Staff Payment History Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import all historical staff payments (Dec 2024 → Jun 1 2026) from 9 platform accounts into a new append-only `staff_payment_history` ledger, create minimal staff accounts for every payee, and surface blended earnings + 1099 year totals.

**Architecture:** Offline parse→classify→review-sheet pipeline (one-off scripts, data never enters the repo), a single-transaction import script gated on Dallas's edited review sheet, and three read-only display surfaces. Live payroll tables are never written.

**Tech Stack:** Node 18 (no new deps; `pdftotext` CLI via `child_process`, stdlib `crypto`/`fs`), raw SQL via `pool.query`, React 18.

## Global Constraints (from spec)

- Money stored as **integer cents**; parse `"$1,043.74"` → `104374`. Never floats in the DB.
- **Boundary:** rows with `paid_on >= '2026-06-02'` NEVER insert into the ledger; they go to the reconciliation report.
- **Primary-source rule (spec §3):** Chase mirrors of Venmo/CashApp/PayPal are `funding`, never payments; mirror-without-primary = flagged, never dropped.
- Import data + review sheets live under `~/win-share/payments/` — **never commit them**; fixtures in the repo are synthetic.
- Created users are **silent**: no emails, no activity feed writes.
- All SQL parameterized; multi-table writes in `BEGIN/COMMIT/ROLLBACK`; new routes use `auth` + `adminOnly` (admin) or `req.user.id` scoping (staff).
- Server tests: `node -r dotenv/config --test <file>` one at a time (shared dev DB).
- Vanilla CSS in `index.css`; client API calls via `client/src/utils/api.js`.

## Execution notes (run order + human gates)

1. **spi-a** and **spi-b** run in parallel (disjoint footprints).
2. **spi-d** starts once spi-a merges (needs the table to exist for its SQL).
3. **HUMAN GATE 1:** after spi-b merges, run `exportKnownPeople.js` + `buildReviewSheet.js` against the real share data; hand `review/people.csv` + `review/transactions.csv` to Dallas; he edits.
4. **HUMAN GATE 2:** fresh pull of CC reports 4+5 (CC dies 2026-07-21), re-run buildReviewSheet (idempotent; preserves Dallas's verdict columns via merge-on-fingerprint), then Dallas's explicit "run the import" for the prod execution of spi-c's script.
5. Reconciliation report output → Dallas marks June+ payouts paid **through the payroll UI by hand**.

---

## Lane spi-a-ledger

### Task A1: `staff_payment_history` table + `users.exclude_from_1099`

**Files:**
- Modify: `server/db/schema.sql` (append at end, before any trailing comment block)

**Interfaces:**
- Produces: table `staff_payment_history` (columns below) and `users.exclude_from_1099 BOOLEAN DEFAULT false` — consumed by spi-c inserts and spi-d SELECTs.

- [ ] **Step 1: Append DDL to schema.sql**

```sql
-- ─── Staff payment history: imported pre-OS-payroll ledger (spec 2026-07-10) ──
-- Financial facts immutable; attribution (contractor_id, event_label, memo)
-- re-runnable via ON CONFLICT DO UPDATE. Historical payments made via
-- Venmo/CashApp/Zelle/PayPal before the 2026-06-02 payroll boundary
-- (boundary_exception = sheet-approved post-boundary pay for pre-boundary
-- work that matches NO payout). NEVER joins pay_periods/payouts at write
-- time; display surfaces blend the two eras with plain SELECT sums.
-- Supersedes the write-only legacy_cc_payouts (same CC source, overlapping
-- dates): earnings/tax surfaces read THIS table only, never both.
CREATE TABLE IF NOT EXISTS staff_payment_history (
  id              SERIAL PRIMARY KEY,
  contractor_id   INTEGER NOT NULL REFERENCES users(id),
  paid_on         DATE NOT NULL,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  platform        TEXT NOT NULL CHECK (platform IN ('venmo','cashapp','zelle','ach','paypal','cash_other')),
  source_account  TEXT NOT NULL,
  external_txn_id TEXT,
  payee_handle    TEXT,
  memo            TEXT,
  event_label     TEXT,
  boundary_exception BOOLEAN NOT NULL DEFAULT false,
  row_fingerprint TEXT NOT NULL UNIQUE,
  source_file     TEXT NOT NULL,
  imported_at     TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT sph_before_boundary CHECK (paid_on < DATE '2026-06-02' OR boundary_exception)
);
CREATE INDEX IF NOT EXISTS idx_sph_contractor_paid_on
  ON staff_payment_history(contractor_id, paid_on);

-- Per-person 1099 exclusion (foreign contractors e.g. Zul: W-8BEN, not 1099-NEC)
ALTER TABLE users ADD COLUMN IF NOT EXISTS exclude_from_1099 BOOLEAN DEFAULT false;
-- Import provenance marker: admin-list chip, audit, undo path; also keeps
-- imported 'deactivated' users distinguishable from legacy CC stubs (cc_id).
ALTER TABLE users ADD COLUMN IF NOT EXISTS import_source TEXT;
```

- [ ] **Step 2: Apply to dev DB and verify**

Run: `cd /home/drbartender/projects/os && node -r dotenv/config -e "const{pool}=require('./server/db');const fs=require('fs');pool.query(fs.readFileSync('server/db/schema.sql','utf8')).then(()=>pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='staff_payment_history' ORDER BY 1\")).then(r=>{console.log(r.rows.map(x=>x.column_name).join(','));process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"`
Expected: column list including `amount_cents,contractor_id,event_label,...` (verify `require('./server/db')` export shape first; use the same import style as `server/scripts/createAdmin.js`).

- [ ] **Step 3: Re-run to prove idempotency** — same command, expected: identical output, no errors.

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(schema): staff_payment_history ledger + users.exclude_from_1099"
```

### Task A2: `.invalid` guard in sendEmail AND sendBatchEmails

**Files:**
- Modify: `server/utils/email.js:52` (first statements of `sendEmail`, BEFORE the dev-skip block — the tests only pass with the guard first) and the `sendBatchEmails` function (same filter applied per message; a message whose recipients all filter away is dropped from the batch, never throws)
- Create: `server/utils/email.invalid.test.js`

**Interfaces:**
- Produces: `sendEmail` silently skips (returns `{ id: 'skipped-invalid' }`) when every recipient ends in `.invalid`; filters mixed lists; `sendBatchEmails` drops fully-`.invalid` messages from its batch. Placeholder emails from the import (`<slug>@imported.invalid`) can never generate a real send from either function.

- [ ] **Step 1: Write the failing test**

```js
// server/utils/email.invalid.test.js
// sendEmail must refuse RFC-2606 `.invalid` recipients (import placeholders).
// Runs without RESEND_API_KEY: the dev-skip path would return 'dev-skipped',
// so the .invalid guard must fire BEFORE dev-skip for this test to pass.
const test = require('node:test');
const assert = require('node:assert');
const { sendEmail } = require('./email');

test('all-.invalid recipients are skipped without sending', async () => {
  const res = await sendEmail({ to: 'chip-weinke@imported.invalid', subject: 'x', html: '<p>x</p>' });
  assert.strictEqual(res.id, 'skipped-invalid');
});

test('mixed list drops only the .invalid address', async () => {
  const res = await sendEmail({ to: ['real@example.com', 'ghost@imported.invalid'], subject: 'x', html: '<p>x</p>' });
  // Notifications are gated off in dev, so the surviving recipient falls
  // through to dev-skip (holds even when RESEND_API_KEY is set in dev .env):
  assert.strictEqual(res.id, 'dev-skipped');
});

test('sendBatchEmails drops fully-.invalid messages without throwing', async () => {
  const { sendBatchEmails } = require('./email');
  const res = await sendBatchEmails([
    { to: 'ghost@imported.invalid', subject: 'x', html: '<p>x</p>' },
  ]);
  // Shape depends on sendBatchEmails' existing return contract — assert the
  // batch resolves and no message reached the provider (read the function
  // first and pin the exact expected value in this test before implementing).
  assert.ok(res);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/utils/email.invalid.test.js`
Expected: FAIL — first test gets `dev-skipped` (guard not implemented).

- [ ] **Step 3: Implement the guard** — first statements of `sendEmail`, BEFORE the `if (!resend || !notificationsEnabled())` block:

```js
  // RFC-2606 `.invalid` recipients are import placeholders (staff-payment
  // import, spec 2026-07-10) — a send to one is always a bug, so drop them
  // before any provider/gating logic.
  const recipients = (Array.isArray(to) ? to : [to])
    .filter((a) => !String(a).toLowerCase().trim().endsWith('.invalid'));
  if (recipients.length === 0) {
    console.log(`[email] skipped: all recipients .invalid → ${to} | Subject: ${subject}`);
    return { id: 'skipped-invalid' };
  }
  to = recipients.length === 1 ? recipients[0] : recipients;
```

- [ ] **Step 4: Run to verify pass** — same command. Expected: 2 pass.
- [ ] **Step 5: Run the neighbor suite to prove no regression**

Run: `node -r dotenv/config --test server/utils/email.quota.test.js`
Expected: PASS (unchanged).

- [ ] **Step 6: Commit**

```bash
git add server/utils/email.js server/utils/email.invalid.test.js
git commit -m "feat(email): refuse .invalid placeholder recipients in sendEmail"
```

---

## Lane spi-b-pipeline

All files under `server/scripts/staffPaymentImport/`. Scripts are CLI-run
(`node server/scripts/staffPaymentImport/<name>.js --data-dir "$HOME/win-share/payments"`),
never imported by the server. Header comment in each file documents usage
(house style: `server/scripts/createAdmin.js`). Real data stays on the share;
`__fixtures__/` contains only fabricated names/amounts.

### Task B1: config + staging row + fingerprint

**Files:**
- Create: `server/scripts/staffPaymentImport/config.js`
- Create: `server/scripts/staffPaymentImport/staging.js`
- Create: `server/scripts/staffPaymentImport/staging.test.js`

**Interfaces:**
- Produces:
  - `config.js`: `{ BOUNDARY: '2026-06-02', dataDir(argv), reviewDir(argv), SOURCE_ACCOUNTS }` where `SOURCE_ACCOUNTS` maps folder/file patterns → `{ platform, source_account }`. It MUST enumerate every spec §2 source: `venmo_business` (root `*-statement.csv`), `venmo_personal` (`New folder` CSVs — sniffed by the `Account Statement -` title row, not just location), `cashapp_business` (root month PDFs), `cashapp_personal` (`New folder` month PDFs), `chase_6835`/`chase_7570`/`chase_8700` (the Chase subfolder, per account dir), `paypal_contact`/`paypal_doctorbartending`/`paypal_wildskybooks` (`Download*.CSV`, routed by which own-account email appears in the file), `cc_expense_log` (report 4, consumed by B6/B7, importable only as `cash_other`).
  - `staging.js`: `makeRow({date, amountCents, platform, sourceAccount, payee, memo, txnId, sourceFile, seq, kind})` → frozen staging row with `fingerprint`; `kind` ∈ `'payment'|'funding'|'other'`. **Fingerprint rule:** when `txnId` is present (Venmo, Zelle refs, PayPal) → `sha256("v1|"+platform+"|"+txnId).slice(0,32)` — stable across re-exports and file reordering; when absent (Cash App PDFs) → `sha256("v1|"+platform+"|"+sourceAccount+"|"+date+"|"+amountCents+"|"+payeeNormalized+"|"+(memo||'')+"|"+sourceFile+"|"+seq).slice(0,32)` with `seq` = 0-based index of identical (date,amount,payee) tuples within one source file. Display form is `"fp-"+hash` (forces text cells in Excel; the `fp-` prefix is part of the stored `row_fingerprint`).
  - `parseMoney('$1,043.74')` → `104374`; `parseMoney('- $105.00')` → `-10500`.

- [ ] **Step 1: Write failing tests** — `staging.test.js` (pure, no DB): `parseMoney` cases (`'$0.01'`→1, `'- $1,000.00'`→-100000, `'204.99'`→20499); fingerprint stability (same input twice → equal); fingerprint uniqueness (two same-day same-amount payments differing only in `seq` → different); boundary constant exported.
- [ ] **Step 2: Run** `node --test server/scripts/staffPaymentImport/staging.test.js` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `config.js` + `staging.js` (no DB imports; `crypto.createHash('sha256')`).
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit** `git add server/scripts/staffPaymentImport/{config.js,staging.js,staging.test.js} && git commit -m "feat(staff-import): staging row + fingerprint + config"`

### Task B2: Venmo CSV parser (business AND personal layouts)

**Files:**
- Create: `server/scripts/staffPaymentImport/parsers/venmoCsv.js`
- Create: `server/scripts/staffPaymentImport/parsers/venmoCsv.test.js`
- Create: `server/scripts/staffPaymentImport/__fixtures__/venmo-business.csv` (synthetic: header row `Transaction ID,Date,Time (UTC),Type,Status,Note,From,To,Amount (total),...` + 3 rows: one outgoing Payment `- $105.00` w/ memo `Testman DrB 4/12`, one incoming Payment, one non-Payment type)
- Create: `server/scripts/staffPaymentImport/__fixtures__/venmo-personal.csv` (synthetic: line 1 `Account Statement - (@Test-User) ,,,…`, line 2 `Account Activity,…`, line 3 header starting with EMPTY first column `,ID,Datetime,Type,Status,Note,From,To,Amount (total),…`, ISO `Datetime`, one outgoing `Payment` row `- $200.00`, one `Merchant Transaction` row)

**Interfaces:**
- Consumes: `makeRow`, `parseMoney` from `staging.js`.
- Produces: `parseVenmoCsv(filePath, {sourceAccount}) → row[]` — outgoing `Type==='Payment'` && `Status∈{'Complete','Completed'}` && negative amount → `kind:'payment'` rows (amount stored positive); all other rows dropped. Layout sniff: scan first 5 lines for the line containing both `'ID'` and `'Amount (total)'`; if the file starts with `Account Statement -` treat as personal (leading empty column, `Datetime` ISO → date = first 10 chars); else business (`Date` col `MM/DD/YYYY` → ISO). CSV parsing: minimal quoted-field splitter in the module (no new deps) — handles `"..."` fields with embedded commas/newlines (Venmo disclaimers contain both).

- [ ] **Step 1: failing tests** — business fixture yields exactly 1 payment row `{amountCents:10500, payee:'…', memo:'Testman DrB 4/12', txnId:'…'}`; personal fixture yields exactly 1 row with `date:'2025-…'` from ISO Datetime; incoming/merchant rows excluded.
- [ ] **Step 2: Run** `node --test server/scripts/staffPaymentImport/parsers/venmoCsv.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add server/scripts/staffPaymentImport/parsers/venmoCsv.* server/scripts/staffPaymentImport/__fixtures__/venmo-*.csv && git commit -m "feat(staff-import): venmo parser, both layouts"`

### Task B3: Cash App PDF parser

**Files:**
- Create: `server/scripts/staffPaymentImport/parsers/cashappPdf.js`
- Create: `server/scripts/staffPaymentImport/parsers/cashappPdf.test.js`
- Create: `server/scripts/staffPaymentImport/__fixtures__/cashapp-sample.txt` (synthetic pdftotext -layout OUTPUT — the test feeds text, not a real PDF: statement header `June 2025\nAccount Statement`, two rows `To Test Person from Chase Bank x0000   Cash App payment   $0.00   $170.00`, one `Cash App Card Order` row)

**Interfaces:**
- Consumes: `makeRow`, `parseMoney`.
- Produces: `parseCashappText(text, {sourceFile, sourceAccount}) → row[]` (pure, unit-tested) and `parseCashappPdf(filePath, opts)` = `execFileSync('pdftotext', ['-layout', filePath, '-'])` → `parseCashappText`. Row regex: `/^To ([A-Za-z .'-]+?) from [\w .]+?\s+Cash App payment\s+\$[\d.]+\s+\$([\d,]+\.\d{2})/m`-per-line; date = statement month/year (from header line matching `/^(January|February|…|December) (20\d\2)$/` — implement as month-name alternation) + day from the row's leading `Jun 10`-style token; non-person rows (`Cash App Card Order`) excluded by the `To … from` shape. No txn ids → `txnId:null` (fingerprint `seq` handles same-day duplicates).

- [ ] Steps 1-5 as B2 (failing test on fixture text → run → implement → pass → commit `"feat(staff-import): cashapp pdf parser"`).

### Task B4: Chase statement parser (Zelle primary + mirror classification)

**Files:**
- Create: `server/scripts/staffPaymentImport/parsers/chasePdf.js`
- Create: `server/scripts/staffPaymentImport/parsers/chasePdf.test.js`
- Create: `server/scripts/staffPaymentImport/__fixtures__/chase-sample.txt` (synthetic pdftotext -layout output: one `Zelle Payment To Test Freyer Jpm99Test123   200.00` row, one `Orig CO Name:Venmo   Orig ID:0000000000 …   157.50` row, one `Payment Sent  08/04 Cash App*Test Person  Oakland CA Card 0000   400.00` row, one `Paypalsec:Web Trace#:…` continuation row, one ordinary debit row)

**Interfaces:**
- Consumes: `makeRow`, `parseMoney`.
- Produces: `parseChaseText(text, {sourceFile, sourceAccount, statementYear, statementMonth}) → row[]`:
  - `Zelle Payment To <name> <ref>` → `kind:'payment'`, `platform:'zelle'`, `txnId:<ref>` (the `Jpm…` token).
  - `Orig CO Name:Venmo` / `Cash App\*<name>` / `Orig CO Name:Paypal` / `Paypalsec:Web` rows → `kind:'funding'` with `fundingOf:'venmo'|'cashapp'|'paypal'` and, for Cash App card rows, `payee` captured from `Cash App*<name>` (drives the mirror-completeness check in B7).
  - Everything else → dropped.
  - Dates `MM/DD` + statementYear; December statements spanning year boundary use statementMonth to disambiguate (a `12/xx` row in a January-dated statement belongs to the prior year).

- [ ] Steps 1-5 as B2 (tests assert: 1 payment w/ txnId `Jpm99Test123` + 3 funding rows w/ correct `fundingOf` + payee on the cashapp mirror; commit `"feat(staff-import): chase parser — zelle primary, app mirrors as funding"`).

### Task B5: PayPal CSV parser (person-types + PHP→USD resolution)

**Files:**
- Create: `server/scripts/staffPaymentImport/parsers/paypalCsv.js`
- Create: `server/scripts/staffPaymentImport/parsers/paypalCsv.test.js`
- Create: `server/scripts/staffPaymentImport/__fixtures__/paypal-sample.csv` (synthetic, BOM-prefixed, quoted: a USD `Mobile Payment` `-180.00` Completed; a PHP `General Payment` `-11,242.39` Completed with `Transaction ID` `TESTPHP1`; its two `General Currency Conversion` rows — PHP credit `+11,242.39` and USD debit `-204.99`, both carrying `TESTPHP1` in the `Reference Txn ID` column; a `PreApproved Payment Bill User Payment`; an incoming `General Payment`)

**Interfaces:**
- Consumes: `makeRow`, `parseMoney`.
- Produces: `parsePaypalCsv(filePath, {sourceAccount}) → row[]`:
  - Person-payment types: `General Payment` and `Mobile Payment`, `Status==='Completed'`, negative `Gross`.
  - USD rows → `amountCents` from `Gross` (abs).
  - Non-USD rows → resolve USD via the sibling `General Currency Conversion` USD-currency row whose `Reference Txn ID` equals the payment's `Transaction ID`; fallback (older exports without back-reference): the USD conversion row with identical `Date`+`Time`. Missing resolution → row emitted with `amountCents:null` + `unresolvedCurrency:true` (B7 lists these; they NEVER silently drop).
  - `payee` = `Name`, `payeeEmail` = `To Email Address` (extra identity evidence for clustering); other types dropped. Strip BOM before header parse.

- [ ] Steps 1-5 as B2 (tests: USD mobile row → 18000 cents; PHP row resolves to 20499 cents via reference row; preapproved/incoming excluded; commit `"feat(staff-import): paypal parser w/ PHP→USD resolution"`).

### Task B6: dictionary, clustering, classification, event matching

**Files:**
- Create: `server/scripts/staffPaymentImport/exportKnownPeople.js`
- Create: `server/scripts/staffPaymentImport/dictionary.js`
- Create: `server/scripts/staffPaymentImport/classify.js`
- Create: `server/scripts/staffPaymentImport/eventMatch.js`
- Create: `server/scripts/staffPaymentImport/classify.test.js`
- Create: `server/scripts/staffPaymentImport/eventMatch.test.js`
- Create: `server/scripts/staffPaymentImport/__fixtures__/cc-expenses.csv` + `__fixtures__/cc-contacts.csv` + `__fixtures__/cc-bookings.csv` (synthetic, matching the real headers exactly: expenses `ID,Date,Amount,Category,Payee,Reference,…,Booking: Title,Booking: Date,…`; contacts `ID,Name,First Name,Last Name,Email,Phone,…,Roles,…,Staff Events: Count,…`; bookings `…,Event Date,…,Assigned Staff,…`)

**Interfaces:**
- Consumes: staging rows.
- Produces:
  - `exportKnownPeople.js` (CLI): read-only `pool.query` of `users` JOIN `contractor_profiles` (staff+manager roles, all statuses, incl. `onboarding_status` so the phone-collision check knows who is `approved`) → writes `<review-dir>/known-people.csv` (`user_id,name,preferred_name,email,phone,onboarding_status`). The ONLY pipeline file that touches a DB; run against prod via `DATABASE_URL` env at operation time. NOTE the nesting: `require('../../db')` + dotenv path `'../../../.env'` (one level deeper than createAdmin.js — its `'../db'` does not resolve from this dir).
  - `dictionary.js`: `buildDictionary({knownPeopleCsv, ccContactsCsv, ccExpensesCsv}) → { people: [{clusterKey, names[], emails[], phones[], osUserId|null, ccStaffTotals}], aliases }`. Name normalization: lowercase, strip punctuation/emoji, collapse whitespace. Hardcoded `ALIASES` map seeds known cross-platform identities discovered in the data: `katie freyer→kaitlyn freyer`, `chip weinke→vernon wienke`, `chip→vernon wienke`, `chima anderson→chi anderson`, `mgm bartending→marie mathews`, `jenn gibson-whalen→jennifer gibson`, `jen phanord→jennifer phanord`, `nicole prowell→nicki prowell`, `josh capleton→joshua capleton`, `jamie lyn juarez→jamie juarez` (sheet can override any).
  - `classify.js`: `classify(row, dict) → {verdict:'staff-pay'|'ignore'|'unsure', person:clusterKey|null, confidence, reason}`. Ignore patterns (case-insensitive substrings): `lyft, uber, massage, gift, cash app card order, allegiant, coach usa, wildsky books` + `kind==='funding'` + agency list `['qwick']` (verdict `ignore`, reason `agency`).
  - `eventMatch.js`: `matchEvents(rows, {ccExpenses, ccBookings}) → rows` with `eventLabel`/`eventEvidence` (`'cc-expense'|'memo'|'inferred'|null`): tier a — CC expense same payee-cluster, |amount| exact, date within ±5 days → booking title + date; tier b — memo regex `/\b(\d{1,2}\/\d{1,2})\b/` or ` - <word>` suffix → memo-derived label; tier c — CC booking where payee ∈ `Assigned Staff` and payment lands 0–7 days after `Event Date` → `"<title> (inferred)"`. First match wins.

- [ ] **Step 1: failing tests** — classify: dictionary hit → staff-pay; `Massage` memo → ignore; funding row → ignore; unknown `Snow Bunny` → unsure. eventMatch: exact-amount CC match wins over memo; 0–7d proximity produces `(inferred)`; no evidence → null.
- [ ] **Step 2: Run both test files** → FAIL.
- [ ] **Step 3: Implement the four modules.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `"feat(staff-import): dictionary, classifier, event matcher"`

### Task B7: buildReviewSheet orchestrator

**Files:**
- Create: `server/scripts/staffPaymentImport/buildReviewSheet.js`
- Create: `server/scripts/staffPaymentImport/buildReviewSheet.test.js` (drives the orchestrator against the fixture dir end-to-end)

**Interfaces:**
- Consumes: every B1–B6 module.
- Produces (CLI: `node …/buildReviewSheet.js --data-dir <dir> [--review-dir <dir>=<data-dir>/review]`):
  1. Walks the data dir (incl. `Chase Statements Dec2024-Jun2026/*/` + `New folder/`), routes each file to its parser via `SOURCE_ACCOUNTS`, content-hash (md5) dedupes identical files, skips non-data files (`ShoppingList`, `WhatsApp*`).
  2. `people.csv`: `cluster,proposed_name,os_user_id,email,phone,current_or_ex,preferred_method,preferred_handle,account_decision,exclude_1099,txn_count,total_usd` — `account_decision` prefilled `existing:<id>` where matched, else blank (Dallas fills `create-current|create-ex|skip`); `exclude_1099` prefilled `yes` for Zul's cluster.
  3. `transactions.csv`: `fingerprint,date,amount_usd,platform,source_account,payee_as_shown,payee_email,memo,txn_id,person_cluster,verdict,confidence,event_label,event_evidence,source_file,post_boundary,boundary_exception` — `post_boundary=yes` rows included for visibility; only ones Dallas flips `boundary_exception=yes` can import (the rest go to reconciliation). **CC-only rows are included here too** as `platform='cash_other'`, `source_account='cc_expense_log'`, `txn_id=<CC expense row ID>`, verdict `unsure` — flipping to `staff-pay` is the spec §3 per-row approval. PayPal rows with unresolved PHP→USD appear with BLANK `amount_usd` + verdict `unsure` (unimportable until resolved — validation rejects staff-pay without a positive amount).
  4. `.manifest.json` (Excel-proofing, spec §7.3): canonical machine facts keyed by fingerprint — `{date, amount_cents, platform, source_account, txn_id, payee, memo, source_file, post_boundary}`. The import (spi-c) reads FACTS from the manifest and ONLY human-judgment columns from the CSVs, so Excel mangling dates/phones/txn-ids in display columns cannot corrupt the import.
  5. `coverage-report.txt`: per-source row counts + USD totals vs spec §2 expected table; Chase mirror rows WITHOUT a matching primary (payee-cluster + |amount| ±1¢ + ±3 days) → `MISSING EXPORT?` list; PayPal `unresolvedCurrency` rows; CC expense rows with no primary match → `CC-ONLY (cash_other candidates)` list; **seeded-phone collisions** — any people.csv phone that (normalized) equals an existing `approved` staffer's `contractor_profiles.phone` from known-people.csv → `PHONE COLLISION` list (a stale CC phone must not shadow a real staffer in the inbound-SMS resolver).
  6. **Re-run merge rule:** if `transactions.csv` already exists, preserve Dallas's `verdict`,`person_cluster`,`event_label`,`boundary_exception` for rows whose `fingerprint` still exists; same for people.csv keyed on `cluster` (all human columns). New rows append; vanished fingerprints are listed in coverage-report, never silently removed.

- [ ] **Step 1: failing end-to-end test** — run orchestrator against `__fixtures__` as `--data-dir`; assert people.csv has the fixture cluster w/ contact info from cc-contacts fixture; transactions.csv has expected verdict column values; coverage-report contains the deliberately-unmatched mirror row from the chase fixture.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Manual smoke against real share data** (not committed, operator step): `node server/scripts/staffPaymentImport/buildReviewSheet.js --data-dir "$HOME/win-share/payments"` — verify coverage-report totals ≈ spec §2 (Zelle 86/$19,324.23; Venmo biz 51/$8,820.88; CashApp 31+14; Venmo personal 5/$870; PayPal rows all currency-resolved). Investigate any mismatch before handing the sheet to Dallas.
- [ ] **Step 6: Commit** `"feat(staff-import): review-sheet builder + coverage report"`

---

## Lane spi-c-import

### Task C1: sheet validation module

**Files:**
- Create: `server/scripts/staffPaymentImport/importValidation.js`
- Create: `server/scripts/staffPaymentImport/importValidation.test.js`

**Interfaces:**
- Consumes: the `.manifest.json` facts + people.csv/transactions.csv human-judgment columns (plain objects; facts come from the manifest per B7 — CSV machine columns are display-only).
- Produces: `validateSheets({manifest, people, transactions}) → {errors: string[], toImport, toReconcile, peopleActions}` — pure function, NO DB. Rules (each violation = one precise error string; import runs ONLY on `errors.length===0`):
  - every `verdict==='staff-pay'` txn has `person_cluster` resolving to a people row, and a manifest entry for its fingerprint (missing manifest entry = mangled/hand-added row = error);
  - that people row has `account_decision` ∈ `existing:<int>|create-current|create-ex` (a `skip` person with staff-pay rows = error);
  - `create-*` rows have non-empty `proposed_name`; email valid-or-blank (blank → slug placeholder is generated later, flagged in the summary); no duplicate emails WITHIN the sheet;
  - human-entered phones/emails normalized on read (trim, strip formatting; `+63…` preserved verbatim — never `normalizePhone`, which is US-centric);
  - boundary: manifest `post_boundary=false` → `toImport`; `post_boundary=true` + staff-pay + `boundary_exception=yes` → `toImport` (flag carried to the INSERT); `post_boundary=true` without the flag → `toReconcile`;
  - manifest `amount_cents` is a positive integer (blank/unresolved + staff-pay = error); no duplicate fingerprints;
  - `verdict` ∈ the three allowed values; `exclude_1099` ∈ `yes|no|blank`; `platform='cash_other'` rows must carry a CC expense `txn_id`.

- [ ] Steps: failing tests (one per rule, plus a fully-valid fixture set) → run `node --test server/scripts/staffPaymentImport/importValidation.test.js` → implement → pass → commit `"feat(staff-import): sheet validation"`.

### Task C2: importFromSheet (single transaction, dry-run default)

**Files:**
- Create: `server/scripts/staffPaymentImport/importFromSheet.js`

**Interfaces:**
- Consumes: `validateSheets`, `pool` — NOTE the extra nesting level: from `server/scripts/staffPaymentImport/` the DB import is `require('../../db')` and dotenv is `require('dotenv').config({ path: path.join(__dirname, '../../../.env') })` (createAdmin.js's `../db` is one level shallower — copying it literally throws `Cannot find module`). Also `bcryptjs`, `crypto`.
- Produces: CLI `node …/importFromSheet.js --review-dir <dir> [--execute]`. Default is **dry-run**: full transaction, prints the complete write plan + per-person/per-year totals, then `ROLLBACK`. `--execute` commits. **Pre-flight (before BEGIN):** query existing `users.email` for every `create-*` email → a hit is a fail-fast error naming the person ("use existing:<id>"); generated `@imported.invalid` slugs disambiguate with `-2`/`-3` suffixes against both existing rows and each other. Flow:

```js
// per person with account_decision 'create-current' | 'create-ex':
//   INSERT INTO users (email, password_hash, role, onboarding_status, pre_hired, exclude_from_1099, import_source)
//     VALUES ($1, $2, 'staff', $3, $4, $5, 'payment_history_import') RETURNING id
//     — email: sheet email || `${slug(name)}@imported.invalid` (pre-flight-disambiguated)
//     — password_hash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12)  // secret discarded
//     — 'create-current' → ('in_progress', true);  'create-ex' → ('deactivated', false)
//   'create-current' only: INSERT INTO onboarding_progress (user_id, account_created) VALUES ($id, true)
//   INSERT INTO contractor_profiles (user_id, preferred_name, phone, email) VALUES …  // preferred_name ALWAYS set (C1 requires it) so lists never fall back to the .invalid email
//   INSERT INTO payment_profiles (user_id, preferred_payment_method, payment_username) VALUES …
//   'existing:<id>': UPDATE users SET exclude_from_1099=$flag WHERE id=$id (flag only; nothing else touched)
// per toImport txn:
//   INSERT INTO staff_payment_history (contractor_id, paid_on, amount_cents, platform, source_account,
//     external_txn_id, payee_handle, memo, event_label, boundary_exception, row_fingerprint, source_file)
//   VALUES (…) ON CONFLICT (row_fingerprint)
//   DO UPDATE SET contractor_id = EXCLUDED.contractor_id,
//                 event_label   = EXCLUDED.event_label,
//                 memo          = EXCLUDED.memo
//   -- financial facts (paid_on, amount_cents, platform) are the row's identity and never change;
//   -- attribution fixes made in the sheet propagate on re-run (spec §5)
// whole thing inside one BEGIN/COMMIT with ROLLBACK on any error OR when !--execute
// after COMMIT: write review/import-run-<ts>.json — sheet checksum, counts
// created/updated/skipped, DATABASE_URL host (redacted), operator note (spec §7.4 audit)
```

  Safety rails: the pre-flight email/slug uniqueness check (above) runs before BEGIN; prints `inserted / attribution-updated / unchanged` counts — a re-run on unchanged input is provably `0 inserted`; NO email/SMS/activity writes anywhere in the script.

- [ ] **Step 1:** implement script (validation module already tested; this task's test IS the dry-run).
- [ ] **Step 2: Dry-run against dev DB with fixture-derived sheets** — expected output: write plan listing users/profiles/ledger counts, per-person-per-year table, `ROLLBACK (dry run)` final line.
- [ ] **Step 3:** `--execute` against **dev** DB; re-run `--execute` again → second run prints `0 inserted` (idempotency proof); then flip one fixture row's `person_cluster` in the sheet and re-run → `1 attribution-updated`, still `0 inserted` (correction-flow proof).
- [ ] **Step 4: Commit** `"feat(staff-import): transactional import script (dry-run default)"`

### Task C3: reconciliation report + post-import verification

**Files:**
- Create: `server/scripts/staffPaymentImport/reconcile.js`
- Create: `server/scripts/staffPaymentImport/verifyImport.js`

**Interfaces:**
- `reconcile.js` (CLI, read-only): loads `toReconcile` rows (post-boundary staff-pay) + `SELECT po.id, po.contractor_id, po.total_cents, po.status, pp.start_date, pp.end_date FROM payouts po JOIN pay_periods pp ON pp.id=po.pay_period_id WHERE po.status='pending'`; matches by person (cluster→user) + amount (±1¢) + period window; writes `<review-dir>/reconciliation-report.csv` with three sections: `MATCHED (mark paid via payroll UI: person, date, amount, payout id, period)`, `PAYMENT WITHOUT PAYOUT (manual decision)`, `PAYOUT STILL UNPAID (fine — awaiting payday)`. **Writes nothing to the DB.**
- `verifyImport.js` (CLI, read-only): prints & asserts — row count vs sheet `toImport` count; `SELECT contractor_id, EXTRACT(YEAR FROM paid_on) yr, SUM(amount_cents) FROM staff_payment_history GROUP BY 1,2` vs sheet totals; zero rows `>= '2026-06-02'` except `boundary_exception=true` ones, and **every exception row matches NO payout (person + amount ±1¢, any status)** — the no-double-count assert; fingerprint uniqueness; every contractor_id resolves to a users row with expected status. Exit 1 on any mismatch.

- [ ] Steps: implement both → run against the dev DB seeded by C2-step-3 → both green → commit `"feat(staff-import): reconciliation report + verification"`.

**Operator runbook (after merge, NOT lane work):** fresh CC reports 4+5 → re-run buildReviewSheet (merge preserves verdicts) → Dallas finishes sheet → `exportKnownPeople` + dry-run vs PROD (`DATABASE_URL` from Render env, read the plan output) → Dallas explicit go → `--execute` **in a low-traffic window** → `verifyImport` → `reconcile` → Dallas works the mark-paid checklist in the payroll UI. **Undo path (if a prod run is wrong):** `DELETE FROM staff_payment_history WHERE imported_at >= '<run ts>'`; created accounts: `UPDATE users SET onboarding_status='deactivated' WHERE import_source='payment_history_import' AND created_at >= '<run ts>'` (or targeted DELETE of the users + cascading profiles if truly never used — per-action approval required). Dallas-side: confirm the share isn't guest-readable and delete the WhatsApp chat zip (EIN letter) from the share root.

---

## Lane spi-d-surfaces

### Task D1: server endpoints

**Files:**
- Create: `server/routes/admin/payrollTax.js` (new file — payroll.js is at 611 lines; ~90 more would trip the 700 soft cap, and these three endpoints are one coherent concern)
- Modify: `server/routes/admin/index.js` (add `router.use('/', require('./payrollTax'));` alongside the existing requires at :8-15)
- Modify: `server/routes/staffPortal/payouts.js`

**Interfaces:**
- Produces (payrollTax.js exports an Express Router, same `auth, adminOnly, asyncHandler` pattern as payroll.js):
  - `GET /api/admin/payroll/contractors/:userId/payment-history` (auth, adminOnly) → `{history:[{id,paid_on,amount_cents,platform,source_account,memo,event_label}], total_cents, blended_total_cents}` where `blended_total_cents` = ledger sum + `SELECT COALESCE(SUM(total_cents),0) FROM payouts WHERE contractor_id=$1 AND status='paid'`. Reads `staff_payment_history` ONLY — never `legacy_cc_payouts` (superseded, write-only).
  - `GET /api/admin/payroll/tax-totals?year=2026` (auth, adminOnly) → `{year, rows:[{user_id, name, exclude_from_1099, ledger_cents, payout_cents, total_cents, platforms:{venmo:…, zelle:…}}]}` — ledger by `EXTRACT(YEAR FROM paid_on)`, payouts by `EXTRACT(YEAR FROM paid_at)` `status='paid'` (constructive receipt; NEVER `pay_periods.payday` — spec §4), FULL OUTER on user, names via `contractor_profiles.preferred_name` fallback `users.email`.
  - `PATCH /api/admin/payroll/tax-totals/:userId/exclude` (auth, adminOnly, body `{exclude: boolean}`) → updates `users.exclude_from_1099`, returns the row.
  - `GET /api/me/payment-history` (staffPortal auth pattern, scoped `req.user.id`) → `{history:[{paid_on, amount_cents, platform}], total_cents, blended_total_cents}` (blend = own ledger + own paid payouts; spec §8.2 "same blend") — NO memo, NO source_account, NO handles (PII discipline: platform only).

- [ ] **Step 1:** implement the four handlers (parameterized SQL, `asyncHandler`, integer years validated `Number.isInteger` + range 2024–2100 else `ValidationError`).
- [ ] **Step 2: Self-seed smoke data** (spi-d may run before spi-c; do NOT assume import data exists): insert two throwaway `staff_payment_history` rows against the dev DB via a one-off `pool.query` (fingerprints `fp-smoke-1`/`fp-smoke-2`, contractor = any existing dev staff user id).
- [ ] **Step 3: Smoke via dev server** (managed bg process — restart it after edits per house rule): `curl -H "Authorization: Bearer <dev-admin-jwt>" 'localhost:5000/api/admin/payroll/tax-totals?year=2026'` → JSON rows including the smoke rows; payment-history endpoint returns them with the blended total; staff endpoint with a dev staff JWT returns only that user's rows. Then `DELETE FROM staff_payment_history WHERE row_fingerprint LIKE 'fp-smoke-%'`.
- [ ] **Step 4: Commit** `"feat(payroll): payment-history + 1099 tax-totals endpoints"`

### Task D2: admin user detail + staff portal blends + imported chip

**Files:**
- Modify: `client/src/pages/admin/userDetail/tabs/PayoutsTab.js` (231 lines)
- Modify: `client/src/pages/staff/PayPage.js` (546 lines)
- Modify: `server/routes/admin/users.js` (staff-list SELECT at :36-51 adds `u.import_source` to the enumerated columns)
- Modify: `client/src/pages/admin/StaffDashboard.js` (render a small "imported" chip when `import_source === 'payment_history_import'` — dozens of placeholder rows must be distinguishable from real onboarders)
- Modify: `client/src/index.css`

**Interfaces:**
- Consumes: D1 endpoints via `api.get`.
- PayoutsTab: second fetch `api.get(\`/admin/payroll/contractors/${userIdParam}/payment-history\`)`; renders below the payouts list: blended all-time total headline (`blended_total_cents`), then historical rows (date · platform chip · amount · memo/event_label muted) — loading/error/empty states per house checklist, with the empty logic handling payouts=0 + ledger>0 (the common ex-staff case: show history, not "No payouts yet" alone). **Replace the hardcoded 1099 placeholder card** (PayoutsTab.js:62-73 "$600 threshold / Tracking pending") with a link to the Payroll page's new tax tab — one 1099 surface, not two. Error state = inline error card + Retry (PayPage precedent).
- PayPage: after the paystubs list, a "Payment history (pre-OS)" section from `/me/payment-history`, collapsed by default behind a disclosure (`<details>`), rows date · platform · amount + blended all-time total; hidden entirely when `history.length===0`. **Fix the page's empty-state gate** (PayPage.js:186 keys on `paidPayouts.length === 0` only): an imported current staffer with ledger history but no OS payouts must NOT see "No pay history yet".
- CSS: `.sph-row`, `.sph-platform-chip`, `.imported-chip` reusing existing chip variables; both skins (`data-theme`) verified.

- [ ] **Step 1:** implement both sections + chip. **Step 2:** verify in browser on localhost (staff page via the staff-host recipe from memory if needed; admin via /staffing/users/:id → Payouts tab) with self-seeded ledger rows (D1 step 2 pattern). **Step 3:** `cd client && CI=true npx react-scripts build` → zero warnings (Vercel gate). **Step 4: Commit** `"feat(ui): historical payment blends + imported chip"`

### Task D3: 1099 tax totals tab

**Files:**
- Create: `client/src/pages/admin/payroll/TaxTotalsTab.js`
- Modify: `client/src/pages/admin/payroll/PayrollPage.js` (tab strip at :52-54 → add `{tab === 'tax' && <TaxTotalsTab />}` + button)
- Modify: `client/src/index.css`
- Modify: `README.md` (folder tree: staffPaymentImport scripts dir + TaxTotalsTab), `ARCHITECTURE.md` (route table: 4 new endpoints; schema section: staff_payment_history + users.exclude_from_1099)

**Interfaces:**
- Consumes: `GET …/tax-totals?year=`, `PATCH …/tax-totals/:userId/exclude`.
- Produces: year picker (default current year; options 2024…current), table (name · ledger · OS payouts · total · platform breakdown title-attr · include/exclude toggle), excluded rows rendered muted + struck total, CSV export button building a Blob client-side (`name,year,total_dollars,excluded` — dollars formatted from cents at the edge only). Toggle is disabled while its PATCH is in flight; failure restores the previous state with an inline error. Fetch errors get the inline-error-card + Retry pattern.
- **PayrollPage wiring is THREE edits, not two** (PayrollPage.js): add to the `TABS` array (:12-16, makes the button), add `'tax'` to the `TAB_IDS` allowlist (:17 — without this the tab silently falls back to `current` and never mounts), and add `{tab === 'tax' && <TaxTotalsTab />}` to the conditionals (:52-54).

- [ ] **Step 1:** implement component + wire tab (all three PayrollPage edits). **Step 2:** browser check both skins incl. toggle round-trip persisting on reload. **Step 3:** `CI=true npx react-scripts build` clean. **Step 4:** docs edits (README tree, ARCHITECTURE routes+schema incl. `payrollTax.js` + `import_source`/`exclude_from_1099`/`boundary_exception` columns). **Step 5: Commit** `"feat(payroll): 1099 tax totals tab w/ per-person exclusion"`

---

## Self-review notes

- Spec §2/§3 (sources, primary rule, cash_other path) → B1 SOURCE_ACCOUNTS, B2–B5, B7 (CC-only rows into transactions.csv + coverage report). §4 boundary + exception → A1 CHECK + C1 rules + C3 no-double-count assert. §5 ledger + fingerprint + attribution-rerun → A1 + B1 + C2 DO UPDATE. §6 users incl. pre-flight, import_source, onboarding_progress → C2 (+A2 guard on both send functions). §7 pipeline incl. manifest Excel-proofing, run log, phone collisions → B1–B7/C1–C3. §8 surfaces incl. staff blend, empty-state fixes, single 1099 surface, TAB_IDS → D1–D3. §9 PII → fixtures-synthetic rule, staff endpoint field-stripping, share-only data. §10 out-of-scope respected (no payouts writes anywhere; reconcile.js is read-only; legacy_cc_payouts never read).
- Type consistency: `amount_cents` int everywhere; `row_fingerprint` = `fp-`+32-hex; verdicts `staff-pay|ignore|unsure`; account decisions `existing:<id>|create-current|create-ex|skip`.
- The `ach` platform enum value exists in the CHECK but no parser emits it today (no direct ACH-to-staff rows found in any statement); kept for `cash_other`-style sheet overrides if Dallas reclassifies a CC-only row as a bank transfer.

## Design-fleet review round (2026-07-10)

Both fleets ran pre-execution (spec: grounding/gaps/risk; plan: fidelity/decomposition/feasibility; gaps was re-dispatched once after a DOA). All accepted findings are folded into the spec + this plan: 1099 flag persisted on `users.exclude_from_1099`; `legacy_cc_payouts` declared superseded; `onboarding_progress` seed; `boundary_exception` escape hatch + structural CHECK; PHP-unresolved rows unimportable; email/slug pre-flight; `.invalid` guard covers `sendBatchEmails`; txn-id-based fingerprints; `cash_other` approval path implemented; staff blended total; tax-year fields pinned (`paid_on`/`paid_at`, never `payday`); manifest-based Excel-proofing; imported chip + `import_source`; run log + undo path; require-path nesting; `TAB_IDS` wiring; `payrollTax.js` extraction (soft cap); spi-d self-seeded smoke; spi-b test globs scoped. Not adopted: nothing — no finding was rejected.
