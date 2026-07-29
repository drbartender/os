# Invoice derivation and the over-billing monitor

**Date:** 2026-07-28
**Status:** §2 (monitor) and §3 (Void UI) SHIPPED. **§1 (derivation) and §4 (script remediation) PULLED — see the post-mortem at the bottom before reattempting.**
**Base:** main @ 52d304b3

## The rule

> **The proposal wins.** An invoice is a derived view of its proposal, never an independent authority for what a client owes.

Locked invoices are the exception, and only because they are receipts: once money has been applied, the row is frozen history.

## The invariant

> **`Σ(open invoice remaining) ≤ owed`**, where `owed = total_price − amount_paid`.

Not equality. Billing a client *less* than they owe is sometimes deliberate: a Deposit invoice is a partial bill by design, and 154 such rows are open in prod right now. Billing a client *more* than they owe is never correct.

The two directions are separate failures with separate urgency, and the monitor (§2) reports them separately.

## Problem

Two mechanisms, four live over-billings, discovered 2026-07-28.

### Mechanism A: the balance formula uses a proxy for "already paid"

`refreshUnlockedInvoices` (`server/utils/invoiceLifecycle.js`) derives a Balance invoice as
`total_price − external_paid − Σ(locked invoice amount_due)`.

The locked-invoice sum stands in for money already collected. That proxy fails whenever a payment exists with no locked invoice backing it, and nothing in the system enforces that such backing exists.

**David Luebke (prop 51).** Paid a $100 Stripe deposit on 2026-05-26. He has no Deposit invoice at all, only INV-0016. So the proxy read $0 collected, and each re-price (7/22, 7/25, 7/27) rewrote INV-0016 to the full total. It read $1,100 against a $1,000 debt.

Meanwhile `createBalanceInvoice`, twenty lines away in the same file, computes the same quantity correctly as `total_price − amount_paid`. Two formulas, one number.

A second latent fault sits in the same expression: `external_paid` is already contained in `amount_paid`, verified on Emiline Mccoy (prop 599: `amount_paid` 360 = payments 260 + `external_paid` 100). The current code subtracts `external_paid` from `total_price` without subtracting `amount_paid`, which is a different basis entirely.

### Mechanism B: bespoke labels are exempt from refresh, with no manual path

`refreshUnlockedInvoices` handles exactly three labels and `continue`s past everything else (invoiceLifecycle.js:149-153). A price change therefore never reaches an `Additional Services`, `Drink Plan Extras`, or `Gratuity Balance` invoice. When a price goes up, an invoice is minted; when it comes back down, that invoice is stranded at the old amount.

This is the dominant failure mode: three of the four live over-billings.

| Client | Prop | Invoice | Shows | Owes | Over-billed |
|---|---|---|---|---|---|
| Cathy Murphy | 491 | INV-0216 `Additional Services` | $185 | $0 | $185 |
| Eve Thornton | 556 | INV-0168 `Drink Plan Extras` | $155 | $0 | $155 |
| Brandon Martin | 557 | INV-0199 `Additional Services` | $150 | $70 | $80 |
| David Luebke | 51 | INV-0016 `Balance` (mechanism A) | $1,100 | $1,000 | $100 |

None had paid the wrong amount (`amount_paid = 0` on every one), so no refunds are owed.

### Amplifier: there is no invoice editing UI at all

`PATCH /api/invoices/:id` exists, is auth-guarded, and supports `label`, `due_date`, and `status='void'` with locked-invoice and has-payments guards. **Nothing in `client/src` calls it.** Every invoice mutation available to an admin is a GET, a create, and a send.

So when either mechanism misfires there is no in-app recovery. The `proposal_activity_log` carries the receipt: on 2026-07-19 a session recorded *"INV-0199 amended in place to avoid minting a second Additional Services invoice"*, which was raw SQL against prod.

## Decision: correct the derivation, do not build an invoice editor

The instinct behind "we cannot edit invoices" is an amount and line-item editor. Rejected. A hand-set `amount_due` is a second authority for the price that drifts from `total_price`, which is exactly mechanism B. Worse, §1 would fight it: the next proposal edit would silently overwrite the typed value, so the feature would appear to work and then quietly undo itself.

The escape hatch is Void, plus the Create and Send buttons that already exist.

## Design

### §1. One derivation, in `refreshUnlockedInvoices`

`owed = max(0, toCents(total_price) − toCents(amount_paid))`. `external_paid` drops out of the expression entirely, which also retires the cc-transfer special case.

Invoices split into two kinds, named by a new `PARTIAL_BILL_LABELS` constant in `server/utils/proposalMoneyShared.js`, alongside the existing `CONTRACT_LABELS` and `OFF_LEDGER_INVOICE_LABELS`:

**Partial bills** (`Deposit`, `Drink Plan Extras`) deliberately bill a subset of what is owed. They keep their intended amount, **capped** at `min(intended, owed)`. A partial bill's intended amount is owned elsewhere and this derivation never raises it, only caps it.

- `Deposit`'s intended amount is `deposit_amount`. This carve-out is load-bearing: 154 open unlocked Deposit invoices exist in prod, and any rule handing every open invoice the full `owed` would rewrite all of them to the full contract price.
- `Drink Plan Extras`'s intended amount is its current `amount_due`, because `findOrRefreshExtrasInvoice` (`server/utils/invoiceExtras.js:240-260`) already writes that column and remains its authority. Capping is the only safe interaction between the two writers: a cap can reduce an over-bill but can never contradict the extras owner's figure. This is what retires Eve Thornton's row.

**Remainder bills** (everything else: `Balance`, `Full Payment`, `Additional Services`, `Gratuity Balance`) get `owed − Σ(open partial bills)`. Deleting the `continue` is what fixes Brandon and Cathy.

Worked against every shape in prod: David `Balance` → $1,000. Brandon `Additional Services` → $70. Cathy `Additional Services` → $0. Eve `Drink Plan Extras` → `min(155, 0)` = $0. Iga `Gratuity Balance` → $100, unchanged. The 154 open Deposits → `min(deposit_amount, owed)`, unchanged.

- **A derived amount of `0` voids the invoice** rather than leaving a $0 bill open. The 2026-07-21 spec flagged that a zero-due invoice can capture `open_invoice_token`. This retires Cathy's and Eve's rows.
- **Two or more non-Deposit unlocked invoices: write nothing, log, capture to Sentry.** Zero such rows exist in prod, so rather than invent an allocation rule with no reality to validate against, it refuses to guess and escalates.

**Line items.** Contract labels (`Deposit` / `Balance` / `Full Payment`) keep today's behavior, regenerated from the proposal. Bespoke labels get a single line carrying the invoice's own label at the new amount, so Brandon's reads "Additional Services, $70". That keeps lines summing to `amount_due` without dumping a paid-for package breakdown onto the invoice.

**Locked invoices are never touched.** This leaves a known, accepted gap: seven locked-but-unpaid `Balance` invoices exist (the 2026-07-20 remediation batch, INV-0193 and INV-0205 through INV-0210). All seven are correct today, and all seven would be stranded by a price edit exactly as mechanism B strands bespoke ones. §2 is what catches that; §1 does not prevent it.

### §2. `balanceInvoiceMonitor.js`, alert-only, both directions

Most of this section is building something already designed and approved at `docs/superpowers/specs/2026-07-21-balance-invoice-reconciler-design.md`, which was cut to alert-only after two design-fleet rounds found reachable money bugs in the auto-mint path and none in detection. **That spec was never implemented. Zero code exists.** It would have caught all four rows above.

- **Over-billed (`payable > owed`).** Never legitimate. Runs on every proposal except `draft` and `archived`, since a quote-stage proposal can be over-billed too. Urgent: the client sees a wrong number in their disfavor and the pay button works.
- **Under-covered (`payable < owed`).** The 2026-07-21 spec's case. Reuse its query and its `status IN ('confirmed','deposit_paid')` filter **verbatim**. That filter is already tuned to exclude the legitimate deposit-stage case and was verified at zero rows against prod. Tuned money SQL does not get re-derived.

Everything else follows that spec: hourly behind `RUN_BALANCE_INVOICE_MONITOR`, `wrapScheduler` with the rethrow so `scheduler_health` cannot read `ok` while the query dies, one Sentry warning per offending proposal with a stable fingerprint, one `proposal_activity_log` row, and a single batched admin email per run throttled to once per 24h per proposal via `balanceScheduler`'s existing marker pattern.

**Alert-only is not in tension with §1.** §1 corrects an existing, tested code path that already runs on proposal edit. The monitor only ever reads and emails. A bug in §1 is a wrong invoice; a bug in the monitor is a spurious email. Preserving that asymmetry is the point.

§2 is also what covers what §1 structurally cannot: the seven locked-unpaid Balance invoices, any future label, and any shape neither party has thought of.

### §3. Wire up the PATCH endpoint that already exists

- **Void action** on each open invoice in `ProposalDetailPaymentPanel.js`, calling the existing `PATCH /api/invoices/:id`. The server already refuses to void anything with payments applied. Combined with the existing Create and Send buttons, this makes any invoice situation reconstructable from the admin UI without SQL.
- **Due date** editing on an open invoice, same endpoint, already supported server-side.

No amount or line-item editing, per the Decision above.

The born-draft trap noted in the 2026-07-21 spec is **already fixed** and needs no work here: `ProposalDetailPaymentPanel.js` has Create and Send buttons, and `server/utils/comms/actions/invoiceSend.js` performs the draft→sent flip behind a `WHERE status = 'draft'` guard that touches nothing else.

The one case left uncovered is a bill that legitimately lives outside the contract total. No such thing exists in prod (Iga Taraska's `Gratuity Balance` is exactly her `owed`, so gratuity sits inside `total_price`; `OFF_LEDGER_INVOICE_LABELS` is deliberately empty). If that need appears, the answer is a real off-ledger label added to that constant, which is the mechanism already built for it.

### §4. Remediation

A one-time script calls `refreshUnlockedInvoices` on the affected proposals and lets the fixed derivation produce the result, so remediation doubles as live validation of §1 on the four cases that motivated it. Idempotent.

| Client | Invoice | Now | After |
|---|---|---|---|
| David Luebke | INV-0016 | $1,000 (hand-corrected 7/28) | $1,000, unchanged |
| Brandon Martin | INV-0199 | $150 | $70 |
| Cathy Murphy | INV-0216 | $185 | voided |
| Eve Thornton | INV-0168 | $155 | voided |

**No client email.** Every change is in the client's favor and the corrected invoice speaks for itself.

**Already done on prod, 2026-07-28:** INV-0016 corrected $1,100 → $1,000 under a guarded single-row UPDATE, with a `proposal_activity_log` row recording the reason. Line items were deliberately left at the contract breakdown, matching every other Balance invoice (INV-0144 shows a $350 package line against a $250 balance). **This holding action is fragile: any price edit on proposal 51 before §1 ships will revert it to $1,100.**

**Emiline Mccoy (prop 599) is out of scope.** Her invoices are internally consistent and fully paid; she has simply paid $360 against a $300 total and is up $60. That is a refund-or-credit decision, not a derivation fault.

## Testing

Against the shared dev DB, one suite at a time via `node -r dotenv/config`.

`invoiceLifecycle` derivation:

1. Balance with a paid deposit and **no** Deposit invoice derives to `total − amount_paid` (the David shape, mechanism A).
2. `external_paid` is not double-subtracted: a proposal with `external_paid` inside `amount_paid` derives correctly.
3. A bespoke-label open invoice re-derives on a price decrease (the Brandon shape, mechanism B).
4. A bespoke-label invoice deriving to `0` is voided, not zeroed (Cathy / Eve).
5. An open unlocked `Deposit` keeps `deposit_amount`, not `owed`, and is capped by `min(..., owed)`.
5b. An open unlocked `Drink Plan Extras` keeps its own `amount_due` when it fits inside `owed`, and is capped when it does not (the Eve shape). A remainder invoice sharing the proposal is reduced by the open extras amount, so the two together never exceed `owed`.
6. Locked invoices are never modified.
7. Two non-Deposit unlocked invoices: nothing written, Sentry captured.
8. Bespoke-label line items collapse to one line summing to the new `amount_due`; contract labels regenerate from the proposal.

`balanceInvoiceMonitor`: the nine cases enumerated in the 2026-07-21 spec, plus the over-billed direction (each of the four shapes above alerts; a correct proposal stays quiet; a deposit-stage proposal stays quiet).

## Blast radius

`refreshUnlockedInvoices` is called on every proposal edit, drink-plan submit, and several webhook paths. Its callers must be enumerated and their suites run, not just the invoice suites. The 154 open Deposit invoices are the largest population touched by the change and are protected by the `min(deposit_amount, owed)` carve-out; a regression there is the worst realistic outcome and needs explicit coverage.

Deployment gate, per the 2026-07-21 spec: after §1 and §4, the monitor's first prod run alerts on nothing.

## Out of scope

- Collapsing the label taxonomy to one open invoice per proposal (the "Option B" structural rewrite). The better end state, deferred because the harm here was silence, not complexity, and §2 buys the protection without betting live client money on a rewrite. Revisit if the monitor starts firing on shapes §1 does not cover.
- Amount and line-item editing on invoices.
- Emiline Mccoy's $60 overpayment.
- Backfilling Deposit invoices for historical proposals that lack them.

---

# POST-MORTEM, 2026-07-28: why §1 was pulled

The derivation rewrite was built, reviewed by a 6-agent fleet, fixed, and re-reviewed. Both review rounds found reachable money bugs, and the second round found that the FIXES had introduced three more. It was reverted rather than patched a third time. §2 and §3 shipped; they never depended on it.

## What shipped

- `balanceInvoiceMonitor.js`, alert-only, both directions, 18 tests. It works against the UNCHANGED derivation, which is the point: it surfaces exactly the defects below instead of trying to fix them.
- The Void action in the payment panel, plus `reconcile_total` on `PATCH /api/invoices/:id`. That flag matters on its own: the extras-void path defaults to the comp semantic, which subtracts the invoice from `total_price`, and on a paid-in-full proposal that invents an overpayment.

## What is still broken in `refreshUnlockedInvoices` (unchanged, live)

1. It derives a Balance as `total_price − external_paid − Σ(locked invoice amount_due)`, using locked invoices as a proxy for money collected. Nothing enforces that a payment has a backing locked invoice (prop 51 did not), so a re-price re-bills the deposit.
2. It skips every label outside Deposit / Balance / Full Payment, so a price DECREASE strands an `Additional Services` / `Drink Plan Extras` / `Enhancement Lab` invoice at its old amount. This produced Brandon Martin, Cathy Murphy, Eve Thornton, and prop 527.
3. `external_paid` is subtracted from a basis that does not subtract `amount_paid`, which is a second latent double-count.

## Why the rewrite failed, and what any retry must resolve FIRST

The rewrite kept failing because it tried to be the single source of truth in a system that has four disagreeing writers of `invoices.amount_due`, plus one genuinely ambiguous label. Fix these before touching the derivation again:

1. **`Drink Plan Extras` has two money semantics under one label.** On the add-on submit path `foldExtrasIntoProposal` puts the money INSIDE `total_price`; on the syrup-only fast path it never does (`routes/drinkPlans/submit.js`: "syrups are additive money that never fold into total_price"). No derivation can be correct while the label alone cannot tell them apart. `voidExtrasInvoiceWithReconcile` already discriminates by inspecting persisted line items; that test, or an explicit column recorded at mint time, needs to become the shared answer.
2. **Four writers.** `refreshUnlockedInvoices`, `invoiceExtras.findOrRefreshExtrasInvoice`, `lineItemCancel.reconcileOpenDeltaInvoices`, and `routes/drinkPlans/lab.js`. `lab.js` is the worst: it runs its own copy of the discredited locked-sum formula PLUS an explicit `external_paid` subtraction, AFTER the refresh, in the same request, overwriting it. Two errors that happen to cancel for the CC-transfer cohort and for nobody else.
3. **`Enhancement Lab` folds into `total_price`** (since 2026-07-20) but is not treated as contract money by the derivation, so it strands the same way.
4. **Invoice `status` is never re-derived.** Any change that can land `amount_due == amount_paid` manufactures stuck `partially_paid` rows; a later payment then routes to them and `linkPaymentToInvoice` refuses with `no_remaining_due`, crediting `proposals.amount_paid` with no `invoice_payments` row.
5. **`createBalanceInvoice`'s idempotency check has no `status <> 'void'` filter**, so once a Balance is voided nothing ever mints a replacement. Any design that voids invoices must fix this first.

## Defects the rewrite ITSELF introduced (do not repeat)

- Deriving every unlocked label destroyed syrup-only extras invoices and admin-created manual invoices (`owed = 0` zeroed and voided them, deleting their line items).
- Netting non-derivable open invoices out of the remainder under-billed the contract by their amount.
- Widening the refresh without widening `createAdditionalInvoiceIfNeeded`'s absorbing guard double-billed a price increase.
- Auto-voiding at `amount_due = 0` voided the BALANCE specifically in the multi-remainder case, permanently (see item 5), leaving a proposal with no payable invoice and no path to create one.
- Netting the cancel-line overpayment by `∉ CONTRACT_LABELS` under-refunded clients, because `Additional Services` and `Enhancement Lab` money IS in `total_price`. `CONTRACT_LABELS` is a refund-scope classification, not a "lives outside the contract" one.

## Also found, still open, unrelated to the derivation

- `lineItemCancel` feeds `planOverpaymentSplits` an un-netted `amount_paid − total_price`, which `refundHelpers.js` documents as forbidden; a cancel-line on a proposal with paid extras over-refunds that money. The obvious fix (netting by `∉ CONTRACT_LABELS`) is wrong, per above.
- `POST /api/auth/register-pre-hired` is public and reaches `onboarding_status = 'hired'` with no admin acting, and `onboardingPromotion.js` treats `'hired'` as admin-conferred. Pre-existing and already live.
- `express-fileupload`'s `limitHandler` fires per file part; the second call throws `ERR_HTTP_HEADERS_SENT` and the route handler then runs on `req.files === null`. One-line guard: `if (res.headersSent) return;`.
