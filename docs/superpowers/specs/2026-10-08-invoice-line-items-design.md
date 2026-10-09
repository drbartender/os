# Invoice Line Items That Add Up: Design

**Date:** 2026-10-08. **Status:** designed in chat with Dallas (bounded brainstorm). He chose the
fold rule in section 3 ("the package line is right") and asked for review before any build.
**Rev 2 (2026-10-08)** folds the design fleet: grounding PASS, risk PASS, gaps FAIL on the
repair's line matching. Rev 2 adds the NULL-total rule, one read of the contract per call, fold
logging with a Sentry tripwire for unexplained gaps, the page's visibility test, an exact
line-matching rule for the repair, a restore point, before-state breadcrumbs, row locks, and drift
assertions. Every finding was checked against code or prod before it was folded; one was rejected
with data (section 6).
**As built (2026-10-08, lane `invoice-lines`):** the code fleet (code-review PASS, consistency PASS
after one comment fix, security SAFE) and the second opinion (codex and gemini pro, no findings)
ran on the lane. Four build-stage changes from that review are folded into the sections below:
`refreshUnlockedInvoices` builds its lines on the first write only, so a refresh that writes
nothing reports nothing; anomalous folds log with `console.warn`; an explicit `undefined`
`opts.totalPrice` reads the row (only `null` turns the fold off); the fold is its own function
(`foldToContract`). Prod facts checked during the build: `invoice_line_items` carries only its
FK, PK and `source_type` CHECK, and 9 negative lines already exist there, so a negative line
cannot hit a constraint; the 8 live proposals whose row disagrees with its snapshot are all
completed events (7 with refunds) with no open contract invoice, so the drift report is quiet on
today's data.
**Sensitive path:** `server/utils/invoice*.js` (`scripts/sensitive-paths.txt`), so the lane gets
the full fleet plus the cross-LLM second opinion before merge.

**Ledger entry this closes** (`docs/fix-list-remaining-2026-07-02.md`): section 1, "Invoice line
items do not add up to the invoice total" (both halves: the discount sign and the override).

## 1. Problem

`generateLineItemsFromProposal` (`server/utils/invoiceLineItems.js:17`) builds the line items of
every Deposit, Balance and Full Payment invoice. Three defects, one function:

1. **A discount prints as a charge.** The adjustments loop (`invoiceLineItems.js:141`) pushes
   `toCents(adj.amount)` for every adjustment. Adjustment amounts are stored positive with a
   `type`; the pricing engine negates `type === 'discount'` (`pricingEngine.js:476`, and again for
   the breakdown at `:574`), the generator does not.
2. **A hidden adjustment prints.** The editor's "Client sees" checkbox
   (`ProposalEditorForm.js:670`) sets `adj.visible`. The client proposal page skips a hidden
   adjustment (`ProposalView.js:605`); the generator prints every one.
3. **An override itemizes at catalog.** The generator reads `pricing_snapshot` and
   `proposal_addons` only, never the contract total, so on a proposal with
   `total_price_override` (or any snapshot that drifted from the row) the lines sum to catalog
   while the invoice bills the contract.

The client invoice page renders every line (`client/src/pages/invoice/InvoicePage.js:351`, fed by
the public token route's SELECT at `server/routes/invoices.js:57`), and the html2pdf Save-as-PDF
is that same page. No admin component and no email template reads invoice lines.

**Prod, read-only, 2026-10-08:**
- 26 non-void invoices across 22 proposals print a discount as a positive line: 13 open (`sent`),
  each on a different upcoming event, and 13 paid and locked. Example: proposal 918, The Core
  Reaction $350 with a visible $100 "Courtesy" discount, has Deposit INV-0490 whose lines read
  $350 + "Courtesy $100.00" = $450 on a $250 contract.
- 5 of 205 live (non-archived, non-draft) proposals carry a hidden adjustment; proposal 913's
  hidden "Budget Match Discount" prints on its invoice as a +$100 charge.
- Adjustments are hand-added (no server code writes one); 16 live proposals created since
  2026-09-01 carry one, so the count grows with every send.
- The override half is live on one open invoice: proposal 756 (event 2026-10-24, unpaid),
  Deposit INV-0315, $400 of lines on a $300 contract. The other override'd native invoices are
  paid receipts on completed events.
- No live proposal carries both an override and adjustments (0 of 205).
- All 65 stored adjustments carry `visible` as a JSON boolean. `proposals.adjustments` equals
  `pricing_snapshot.adjustments` on every proposal. No proposal has two adjustments with the same
  label. One adjustment has a blank label and prints on no live invoice (no non-void invoice has a
  line reading "Adjustment").
- Every wrong line matches its adjustment's label verbatim, trailing spaces included ("Courtesy ",
  "Courtesy Discount "), and its amount exactly.

## 2. Goal

- An invoice never shows a discount as a charge.
- An invoice's lines always add up to the contract total (`proposals.total_price`), whenever the
  proposal has a package line and a contract total.
- An invoice never shows a client an adjustment Dallas unchecked "Client sees" on (one accepted
  exception, the fallback in 4.1, which no prod row is near).
- The invoices already wrong on prod are corrected.

## 3. Decision (Dallas, 2026-10-08)

**The difference folds into the package line.** When the itemized lines do not reach the contract
(a hidden adjustment, an override, snapshot drift), the gap lands on the package line rather than
on a separate "Pricing adjustment" line. A $400 Core Reaction with a hidden $100 Budget Match
reads "The Core Reaction $300", so the invoice adds up and the client never sees a line that was
hidden on the proposal.

## 4. Design

### 4.1 The generator

Split the function into a pure builder plus the existing DB wrapper, so the rules are testable
without the database:

- `buildInvoiceLineItems({ snapshot, packageName, packageId, addonRows, totalPriceCents })`
  (pure, exported for tests) returns `{ items, fold }`, where `fold` is
  `{ gapCents, explainedCents, unexplainedCents, applied }` and `applied` is `'package'`,
  `'fallback'` or `null`.
- `generateLineItemsFromProposal(proposalId, dbClient, opts = {})` keeps its return shape (the
  items array). `opts.totalPrice` is the row's `total_price` exactly as the caller read it
  (NUMERIC dollars, possibly null). When it is undefined (absent, or a caller whose SELECT dropped
  the column) the wrapper reads `p.total_price` in its own proposal SELECT; only an explicit
  `null` means "no contract total". Either way it converts once: null, undefined or
  non-finite becomes `null`, anything else goes through `toCents` (`invoiceShared.js:21`).
- The four lifecycle callers already hold the total they derive `amount_due` from, so they pass
  it, and lines and amount due come from one read: `refreshUnlockedInvoices` (its
  `prop.total_price`, read without a row lock by the admin re-price caller), `createInvoiceOnSend`,
  `createBalanceInvoice`, and `upgradeDepositInvoiceToFull` (read under its `FOR UPDATE`). The two
  scripts (`backfillFullPaymentInvoices.js:284`, `backfillProposal54DepositInvoice.js:69`) keep
  calling it bare and get the in-transaction read.

The builder keeps every existing line exactly as today (package, Additional Bartender(s), add-ons
from `proposal_addons` skipping $0, Bar Rental, Signature Syrups, Gratuity), then:

1. **Adjustments.** An adjustment gets a line only when it passes the proposal page's own test
   (`if (!adj.visible) skip`, `ProposalView.js:605`), so the two client surfaces cannot disagree.
   Amount is `Math.abs(Number(adj.amount) || 0)`, negated when `adj.type === 'discount'`, the same
   rule as the engine and the page. A zero amount gets no line. An empty label falls back to
   "Discount" or "Surcharge" by type (the page's fallback), replacing today's "Adjustment".
   `source_type` stays `'manual'`.
2. **Fold.** Only when `totalPriceCents` is not null AND a package line exists:
   `gap = totalPriceCents - sum(line_total)`. If `gap !== 0`:
   - when `package.line_total + gap >= 0`, add `gap` to the package line's `line_total` and set
     its `unit_price` to match (quantity stays 1), `applied = 'package'`;
   - otherwise leave the package line at catalog and append one line, description "Pricing
     adjustment", `source_type 'manual'`, carrying the whole gap, `applied = 'fallback'`. This
     branch needs a hidden discount or an override larger than the package base. It can show the
     client that a hidden adjustment exists, which is accepted for a case no prod row is near,
     and it always reports to Sentry (step 3).
3. **Classify and report.** The snapshot itself says how much of the gap it expects:
   `explainedCents = toCents(snapshot.total) - (toCents(snapshot.subtotal) + visibleAdjNetCents +
   gratuityLineCents)`, which equals the hidden adjustments' signed sum, or the override's
   difference, or the engine's `max(0, ...)` clamp (`pricingEngine.js:480`, `:488`). It is null
   when the snapshot has no finite `total` or `subtotal`. `unexplainedCents = gapCents -
   explainedCents` (the whole gap when explained is null) is drift: the row disagreeing with its
   snapshot, or the lines disagreeing with the snapshot's components (for example a legacy hosted
   snapshot with pre-zeroed staffing, `invoiceLineItems.js:58`, or a $0 `proposal_addons` row the
   snapshot still prices). The wrapper never changes behavior on it; it reports it:
   - every applied fold writes one console line (proposal id, gap, explained, unexplained,
     `applied`, drift), `console.warn` when it is drift or the fallback, `console.log` otherwise;
   - `Sentry.captureMessage('invoice_lines_unexplained_fold', 'warning')` when
     `|unexplainedCents|` exceeds one cent per itemized line (per-line rounding), with the same
     figures as extras;
   - `Sentry.captureMessage('invoice_lines_fold_fallback', 'warning')` whenever step 2 takes the
     fallback.
   Both follow the guard pattern in `invoiceLinking.js:18` (`if (process.env.SENTRY_DSN_SERVER)`),
   and each capture sits in a try/catch, because the report runs inside payment webhook
   transactions and must never throw. `refreshUnlockedInvoices` builds its lines lazily, on the
   first invoice it actually rewrites, so a refresh whose invoices are all locked (the refund
   shape) builds and reports nothing.
4. **No contract total, or no package line** (a legacy or empty snapshot): no fold and no report,
   the lines are returned as built. This keeps today's behavior on those rows, keeps a NULL total
   from folding a whole invoice to $0, and keeps the full-pay guard's refusal meaningful (4.2).

The fold target is the ROW (`proposals.total_price`), not `snapshot.total`. They agree on a
healthy proposal; where they do not, the row is the contract every invoice amount is derived from.
Proposal 527 is the live example: snapshot total $450, contract $370.

Hidden adjustments need no special handling beyond step 1: they are left out of the lines while the
contract still includes them, so step 2 folds them into the package line. The same is true of an
override and of the engine's clamp.

### 4.2 Knock-on behavior

- **No money moves.** Billing never derives from lines: `amount_due` comes from `total_price`,
  `deposit_amount`, `external_paid` and locked totals in every writer, and the page prints
  "Invoice Total" from `amount_due` (`InvoicePage.js:365`). Payroll, refunds and the
  balance-invoice monitor (`balanceInvoiceMonitor.js:49`) never read `invoice_line_items`. The
  readers that compute with lines (`invoiceExtras.js:353`, `:439`; `lineItemCancel.js:372`) read
  Drink Plan Extras invoices only, written by their own writer (`invoiceExtras.js:142`), and
  `refreshUnlockedInvoices` skips every label but Deposit, Balance and Full Payment.
- **The full-pay upgrade and backfill now regenerate more often.** Both regenerate lines only when
  the generated lines sum to the contract (`invoiceLifecycle.js:514`; the backfill's check inside
  `applyCandidate`, `backfillFullPaymentInvoices.js:285-290`, against the payment). With the fold
  that holds whenever a package line and a total exist, so discounted and override'd proposals now
  get fresh lines. The guard stays and still refuses a package-less generation. The upgrade runs
  inside both webhook rails' `SAVEPOINT deposit_upgrade`; the fold adds no new way for
  `writeLineItems` to throw (no CHECK on a negative `line_total`, `'manual'` is allowed). The admin
  record-payment entrance (`server/routes/proposals/actions.js:321`) calls the upgrade without a
  savepoint, as it does today.
- **Two total movers do not refresh invoices, and the fold now presents them.** A contract-scope
  refund (`refundHelpers.js:597`) and the void of a folded extras invoice (`invoiceExtras.js:448`)
  lower `total_price` without touching the snapshot. The next regeneration folds that reduction
  into the package line. That is the intended reading: both are contract reductions, and the
  invoice should show the contract. Each also trips the unexplained-gap report, because the row
  moved away from its snapshot, which is the tripwire that makes the reduction visible to Dallas.
- **Comments that go false are corrected:** the guard comment above `invoiceLifecycle.js:514`; the
  comment inside `applyCandidate` at `backfillFullPaymentInvoices.js:285-289` (the header at
  lines 16 to 28 stays true); the empty-snapshot test's comment in
  `backfillFullPaymentInvoices.test.js`; `scripts/cc-balance-invoice.js:12-14` ("override-blind");
  and `ARCHITECTURE.md` (the `upgradeDepositInvoiceToFull` paragraph under `invoices`, which says
  an override'd proposal keeps its old lines). The `invoice_line_items` schema entry in
  `ARCHITECTURE.md` gains one sentence on the add-up rule and the two Sentry messages.
- **Untouched on purpose:** Additional Services, Service Extension, Drink Plan Extras and manual
  invoices (bespoke writers); the Check Cherry transfer invoices (hand-minted by
  `scripts/cc-balance-invoice.js` with the discount already negative and a "Less deposit already
  paid" credit line, excluded from the repair by `external_paid = 0`); the client proposal page,
  whose own lines still do not add up on a hidden-adjustment or override'd proposal (a separate
  surface, not in this change).

### 4.3 Tests

New `server/utils/invoiceLineItems.test.js`, pure builder cases, each asserting the lines sum to
the contract where a package line and a total exist:
- a visible discount prints negative, label kept verbatim;
- a surcharge prints positive;
- a hidden discount prints no line and the package line is reduced by it (`explained` = the gap);
- an override folds the gap into the package line (Core Reaction $350 + Bar Rental $50 on a $300
  contract reads Core Reaction $250, Bar Rental $50);
- the below-zero fallback appends one "Pricing adjustment" line and leaves the package at catalog;
- no package line: no fold; a null or NaN `totalPriceCents`: no fold;
- a gratuity line is unchanged and counted;
- an empty label falls back to "Discount" / "Surcharge"; a zero amount prints nothing;
- a snapshot whose total disagrees with the row reports the difference as `unexplainedCents`, and
  a one-cent rounding difference does not.

DB cases for the wrapper: it reads `total_price` and `proposal_addons` and returns the folded
result; an explicit `opts.totalPrice` wins over the row; `opts.totalPrice: null` means no fold.
`invoiceHelpers.gratuity.test.js` keeps passing unchanged (its totals already match).

`invoiceLifecycle.upgrade.test.js`, "lines that do not sum to the money stay as they were"
(`:208`) pins the old behavior. It is rewritten to the new one (total moved, lines regenerate, the
package line carries the difference, breadcrumb `lines_regenerated: true`), and a new case pins
the guard's remaining job: an empty snapshot keeps the old lines with `generated_sum_mismatch`.
The backfill's empty-snapshot test already covers that case for the script and keeps passing.

`client/src/pages/invoice/InvoicePage.test.js` gains a negative-line fixture pinning "-$100.00" in
both money columns, since the PDF is the same page.

The new suite and `invoiceLifecycle.upgrade.test.js` are added to `scripts/money-smoke-list.txt`
(the upgrade suite was never on it, so the rewritten behavior would otherwise go ungated). Server
suites share the dev database: run one at a time and read the pass count.

### 4.4 The prod repair

Runs AFTER the push (before it, any re-price would regenerate an open invoice with the old
generator), and never at the same time as the full-pay backfill (both write locked receipts).
This box cannot point a script at prod, so it is a guarded `DO` block through the Neon MCP on the
production branch, in three steps, the second and third on Dallas's say-so.

**Step 0, restore point.** Create a Neon branch of production immediately before step 2. A
wrong-but-passing rewrite of a paid receipt is then recoverable without point-in-time restore.

**Step 1, the approval list (read-only SELECT).** Scope: non-void invoices labelled Deposit,
Balance or Full Payment, `external_paid = 0`, proposal 600 excluded (legal hold). Adjustments are
read from `pricing_snapshot.adjustments`, the source the generator printed from. A line MATCHES an
adjustment when it is `source_type = 'manual'`, its description equals the label verbatim (no
trim, no case fold; a blank label matches the old generator's "Adjustment"), and its `line_total`
equals `round(abs(amount) * 100)`. The list shows, per invoice: invoice number, proposal, locked,
the before lines, an md5 of the before lines, and the planned after lines, classified as:
- **open-explained:** unlocked, every matched discount line accounted for, and any remaining gap
  to `total_price` explained by an override or a hidden adjustment;
- **open-unexplained:** unlocked with a gap the snapshot does not explain (the 527 shape). Skipped
  and named; it heals on its next regeneration through the fixed generator;
- **receipt:** locked.
It also lists, never to be touched: the **residue**, every positive `'manual'` line in scope that
matches no current adjustment (on 2026-10-08: INV-0228 "Special Offer" on proposal 664, whose
adjustment is gone, and INV-0467 "Balance" on proposal 789, which is not an adjustment line); and
the counts of blank labels, duplicate labels, and adjustments with a negative or missing amount on
the selected proposals (0 duplicates and 0 negative or missing amounts on 2026-10-08).

**Step 2, the `DO` block.** The approved list is embedded as `(invoice id, locked, before-lines
md5)` tuples. The block sets a short `lock_timeout`, locks the selected proposals and then their
invoices `FOR UPDATE` (the repo's lock order: proposals, then invoices), re-reads each invoice, and
RAISEs, rolling everything back, on any drift: a tuple whose lock state or lines md5 changed, a
selected invoice not in the list or listed but no longer selected, a duplicate label or a negative or
missing adjustment amount on a selected proposal, or a matched-line count that differs from the
plan. Every `UPDATE` and `DELETE` asserts
its row count with `GET DIAGNOSTICS`. Before changing an invoice it writes one
`proposal_activity_log` row (action `invoice_lines_corrected`, actor `system`, details: invoice id
and number, locked, `from_line_items`, `to_line_items`), the backfill's breadcrumb precedent
(`from_line_items` in `applyCandidate`, `backfillFullPaymentInvoices.js:308`). Corrected amounts are computed from the adjustments, never
from the lines.
- **open-explained:** negate each matched visible discount line; delete each matched hidden line;
  fold `total_price - sum(lines)` into the package line. A package line must exist and stay at or
  above $0, else RAISE. Assert the result sums to `total_price`. This is sign, hidden and fold
  only, not a full regeneration: it cannot rename a line or drop a $0 adjustment (none exist), and
  any later edit regenerates these rows through the fixed generator anyway.
- **receipt:** the same sign and hidden corrections, but NO fold to the current total, because 6
  of the 13 receipts no longer match their contract (it moved after they were paid) and a receipt
  describes what was paid. A hidden line's signed amount moves onto the package line, which must
  exist and stay at or above $0, else RAISE. Visibility is read from the current snapshot, the only
  record of it, so the receipt shows what the open invoice on the same proposal shows (on
  2026-10-08 one receipt carries a now-hidden discount: INV-0455 on proposal 888, beside its open
  Balance INV-0457). Assert each receipt's new sum equals its old sum minus twice the corrected
  discount amounts. Money columns never move.

**Step 3, verify.** A follow-up SELECT shows every touched invoice's lines and sums, and the
breadcrumb count equals the touched-invoice count.

Idempotent: a corrected invoice no longer matches. Order against the full-pay backfill does not
matter once the generator fix is live (the backfill regenerates through the fixed generator; a
receipt it already fixed no longer matches here), but the two never run at once.

## 5. Build

One lane, `invoice-lines`, cut from main after this spec's review.

**Footprint:** `server/utils/invoiceLineItems.js`, `server/utils/invoiceLineItems.test.js` (new),
`server/utils/invoiceLifecycle.js` (the three callers pass the total; one comment),
`server/utils/invoiceLifecycle.upgrade.test.js`, `server/scripts/backfillFullPaymentInvoices.js`
(comment only), `server/scripts/backfillFullPaymentInvoices.test.js` (comment only),
`scripts/cc-balance-invoice.js` (comment only), `scripts/money-smoke-list.txt`,
`client/src/pages/invoice/InvoicePage.test.js`, `ARCHITECTURE.md`.

**Order:** failing builder tests, builder and wrapper, callers pass the total, the upgrade test
rewrite, the client test, comments and docs, touched suites run one at a time. Review: full fleet
plus `/second-opinion`. After the push: the repair (4.4), then the ledger entry is deleted and the
full-pay backfill entry loses its "run it after the generator fix" note.

## 6. Review findings not folded

- **"A native Full Payment invoice locks at its pre-gratuity amount when the client elects
  gratuity at payment"** (gaps). Not folded: it is outside this change, and prod shows no instance.
  On 2026-10-08 the only non-transfer Full Payment invoice on a gratuity proposal that is short of
  its contract or its payment is INV-0448 (proposal 883), an upgraded deposit whose gap is a $125
  surcharge added after payment. (Two of the four rows first cited here, 898 and 823, were
  upgraded deposits and so never showed the native path; the reviewer was right to say so.) The
  code path was not traced, so the claim is filed below the divider in the ledger to trace, not
  dismissed.
- **The admin record-payment entrance runs the upgrade without a savepoint** (risk). True and
  pre-existing; the fold adds no new failure there, so it stays out of this change.
