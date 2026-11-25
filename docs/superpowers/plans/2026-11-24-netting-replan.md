---
spec: docs/superpowers/specs/2026-11-24-netting-replan-design.md (revision 3; revision 2 approved by the owner 2026-11-24, "write the plan")
format: lane map without code (spec 2026-10-19 D12)
revision: 2 (2026-11-24, after the plan review; revision 1 was 13e0ec54)
status: planned; no lane cut
build: one pass per lane in its own lane worktree (each lane is small and its parts share one file set, so parallel subagents would only add hand-offs); review per lane with the review skill before merge; one lane merged and shipped at a time
order: >
  third-kind-ends, then extras-void-to-balance, then recorded-deposit-balance (each shares a file with the one
  before, not a dependency); chargeback-alert is independent and may be built beside them; dispute-inbox-item
  after chargeback-alert. Revert the newest lane first. ARCHITECTURE.md prose is shared by third-kind-ends (the
  kinds of money, near line 3327) and chargeback-alert (the webhook's dispute record), in different sections: the
  second to merge resolves an ordinary prose conflict from both diffs and reports it.
lanes:
  - id: third-kind-ends
    status: planned
    scope: >
      Spec 5.1 to 5.4 and section 6; bundled because both halves end the same third kind of money and the
      law 5 rewrite states both. (1) A v1 drink-plan submit that adds priced syrups the booking lacks (not
      self-provided, not in pricing_snapshot.syrups.selections) and nothing else takes the transaction path:
      hasFinancialSideEffects in submit.js becomes true for it, so foldExtrasIntoProposal moves the total (its
      legal-hold refusal, row lock and status reconcile included) and the add-to-balance branch refreshes the
      Balance or mints Additional Services. Where that path would skip the fold (no package, guest count or
      duration, submit.js near line 423), a syrup-only submit is refused before any write with 409
      SYRUPS_NOT_PRICEABLE. (2) Syrups alone are never paid up front: create-drink-plan-intent refuses (409
      SYRUPS_ADD_TO_BALANCE) when the extras it would charge are priced syrups and nothing else, under either
      payment choice, and the submit refuses a paid_separately submit of syrups alone with the same code,
      before any write; a mixed submit is unchanged. (3) The v1 ConfirmationStep offers only add to balance
      when the only extras are syrups, and its syrup quote shows the booking's syrup cost with the new bottles
      minus without. (4) sumOffContractPaidCents stops counting free-text invoices and counts only Drink Plan
      Extras invoices the line rule reads as unfolded (booking 599's alone); its header and the stale premise
      notes (submit.js fast-path comment, refundHelpers.js near 556 and 691, balanceInvoiceMonitor.js near 80)
      are rewritten. (5) The admin create-invoice form carries the one-line hint of spec 5.3. (6) Money laws 5
      and 7 are rewritten as spec section 6 says, and ARCHITECTURE.md's prose on the kinds of money (near line
      3327) follows.
    footprint:
      - server/routes/drinkPlans/submit.js (the hasFinancialSideEffects condition, the two syrup-only refusals, the fast-path comment)
      - server/routes/stripe.js (create-drink-plan-intent's refusal only)
      - server/utils/drinkPlanExtras.js (a syrup-only predicate beside computeExtrasBreakdown, if the lane needs one)
      - server/utils/invoiceExtras.js (sumOffContractPaidCents and its header only)
      - server/utils/refundHelpers.js (the two comments only)
      - server/utils/balanceInvoiceMonitor.js (the comment only)
      - any further reader the task 1 re-grep shows must change, named in the lane report before it is edited
      - client/src/pages/plan/steps/ConfirmationStep.js (the payment choices and the syrup quote; 811 lines, must stay under 1000)
      - client/src/pages/plan/PotionPlanningLab.js (only if the refusal codes need their own message there)
      - client/src/pages/admin/ProposalDetailPaymentPanel.js (the create-invoice hint only; 836 lines)
      - docs/money-laws.md (laws 5 and 7)
      - ARCHITECTURE.md (the kinds-of-money prose near line 3327), README.md (generated sections)
      - new tests beside each changed server file, ConfirmationStep and the panel
    blockedBy: []
    lenses: money, seams, client, access-egress (a public token route gains two refusals), verify; the full set plus the second opinion, since this is a money path.
    laws: >
      Money law 4 (the fold's catalog recompute is accepted on this door, spec 5.1); laws 5 and 7 (rewritten,
      each with a "Checked against code" line written only after the verify pass reads it); law 8 (unchanged);
      law 15 (the fold's refusal covers the legal-hold booking; the refusals write nothing); the cross-cutting
      invariant over all four symbols spec section 7 names (the extras label, extrasLinesAreFolded,
      sumOffContractPaidCents, offContractPaidCents); the error-response invariant (the 409s carry a
      client-readable message and no internals).
    test plan: >
      DB-backed suites beside submit.js and stripe.js (dev database, one at a time); pure suites for
      sumOffContractPaidCents and the overpayment derivation with stubbed rows; client suites for
      ConfirmationStep and the panel's hint. Then every suite the change reaches (the drinkPlans,
      invoiceExtras, refundHelpers, lineItemCancel, proposals crud and balanceInvoiceMonitor suites) and the
      money smoke (npm run test:smoke). Each new suite fails on main before the fix.
  - id: extras-void-to-balance
    status: planned
    scope: >
      Spec 5.6. Voiding an unpaid Drink Plan Extras invoice that the line rule reads as folded never lowers
      total_price: PATCH /api/invoices/:id no longer reaches the subtracting branch whatever the request sends
      (the reconcile_total default and the reconcileTotalPrice true branch go, or refuse), the extras stay in
      the total, and after the void the open invoices together demand what the booking still owes: an
      unlocked Balance or Full Payment absorbs it through refreshUnlockedInvoices; with none, one Additional
      Services invoice carries the shortfall (total_price minus amount_paid, floored at 0, minus what the open
      invoices already demand), nothing when that is 0. A legacy unfolded invoice stays a plain void. The
      route refuses a void on the legal-hold booking (isLegalHold, fail closed) before any write and holds
      the proposals row FOR UPDATE through the void and the mint. The activity row's reason stops saying
      comp. The admin void control drops the waive choice and says: voiding moves these extras onto the
      balance; to give them away, add a discount. The stale comment in paymentIntentSucceeded.js near line
      192 is corrected.
    footprint:
      - server/routes/invoices.js (the PATCH handler's void branch only)
      - server/utils/invoiceExtras.js (voidExtrasInvoiceWithReconcile only)
      - server/utils/invoiceLifecycle.js (only if the shortfall mint needs a small helper beside createAdditionalInvoiceIfNeeded; its body is not changed)
      - server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js (the comment only)
      - client/src/pages/admin/ProposalDetailPaymentPanel.js (handleVoidInvoice and its copy)
      - README.md (generated sections); new tests beside invoices.js, invoiceExtras.js and the panel
    blockedBy: [third-kind-ends]
    lenses: money, concurrency (the row lock across the void and the mint), seams, client, verify; the full set plus the second opinion.
    laws: law 5 (Additional Services is inside the total); law 8 (no reprice, so no status move; the lane confirms the void needs no reconcile); law 15 (the new refusal); the owner's call of 2026-11-18 (comps through a discount).
    test plan: >
      A DB-backed suite beside invoices.js: the void on a booking with an unlocked Balance (the Balance
      demand grows by the voided amount, total unchanged), on a booking whose every other invoice is locked
      (one Additional Services at exactly the shortfall), on a booking that owes nothing (no mint), a request
      sending reconcile_total true or omitting it (total unchanged), the legal-hold booking (409, nothing
      written), a legacy unfolded invoice (plain void), and two concurrent voids of the same invoice on two
      connections (one succeeds, at most one Additional Services). A client suite for the void control. Then
      the invoices, invoiceExtras, invoiceLifecycle and drinkPlans submit suites and the money smoke.
  - id: recorded-deposit-balance
    status: planned
    scope: >
      Spec 5.7. The admin Balance route's at-deposit precondition (invoices.js, the isBalanceRequest block:
      one live invoice, a paid and locked Deposit, amount_paid equal to the deposit plus external money)
      moves into a shared helper both the route and record-payment call. After its invoice link and inside
      its transaction, record-payment calls createBalanceInvoice only when that helper says the booking is
      at deposit and the booking is not on legal hold; otherwise it mints nothing and its response carries a
      field saying the remainder has no payable invoice yet, which the admin panel shows after the record.
      createBalanceInvoice and the Stripe rails are unchanged. A full record mints nothing.
    footprint:
      - server/utils/balanceAtDeposit.js (new; the shared precondition)
      - server/routes/invoices.js (the isBalanceRequest block calls the helper; behavior unchanged)
      - server/routes/proposals/actions.js (the record-payment handler only)
      - client/src/pages/admin/ProposalDetailPaymentPanel.js (the record-payment result note only)
      - README.md (generated sections); new tests beside the helper, record-payment and the panel
    blockedBy: [extras-void-to-balance]
    lenses: money, concurrency (the read under the record-payment lock), seams, client, verify; the full set plus the second opinion.
    laws: law 8 (the paid flag after the record is unchanged); law 1 (the Deposit invoice stays the retainer's record; nothing relabels it); law 15 (no mint on the legal-hold booking); the one-pooled-connection invariant (the helper takes the caller's client).
    test plan: >
      A suite for the helper (each state the precondition names); a DB-backed suite beside record-payment: a
      deposit-sized record on a booking at its sent Deposit (a Balance at total minus paid, due on the row's
      balance_due_date), a partial below the deposit (no Balance, the response field set), a full-terms
      booking with an open Full Payment (no Balance), a full record (none), the legal-hold booking (none). A
      client suite for the panel's note. The existing admin Balance route suites pass unchanged. Then the
      proposals actions, invoices and invoiceLifecycle suites and the money smoke.
  - id: chargeback-alert
    status: planned
    scope: >
      Spec 5.5 without its Inbox paragraph. A dispute table in schema.sql (idempotent), keyed on the Stripe
      dispute id, with the fields spec 5.5 lists. A handler for charge.dispute.created, charge.dispute.updated
      and charge.dispute.closed routed from stripeWebhook.js by name (the two funds_* routes stay as they are),
      which upserts the row by the ordering rule of spec 5.5 (a later created applies; a tie applies when its
      status ranks at least as far; a closed status never goes back), matches the booking through
      proposal_payments or the tip through tips, and after commit sends the open alert through
      notifyAdminCategory (payment_failure, push on, no SMS) only when the row is first recorded waiting on
      evidence; a dispute first seen under review or closed is recorded with no email. The open alert's claim
      is atomic, so two handlers racing on one dispute send it once, and its stamp is written only on a
      successful send. The email carries the booking id, its event type label (getEventTypeLabel) and date,
      the amount, Stripe's reason in plain words, the deadline as a Chicago date and time or "Stripe gave no
      deadline", and links to the dispute in the Stripe dashboard and to the booking; a tip dispute names the
      tip, an unmatched one the Stripe ids. A daily pass, run by a new module that the existing
      stripe_payout_sweep scheduler calls in place of the payout sweep alone (the payout sweep first, then the
      dispute pass, each in its own try and Sentry tag; no new environment variable; server/index.js changes
      by its require and call lines only, net zero lines): it re-reads every dispute not closed from Stripe
      and applies its status, retries unsent open alerts, and sends the reminder for a dispute still waiting
      on evidence with its deadline within three Chicago days, once, sending when the Stripe read fails.
      Sentry captures for an unmatched dispute, a failed Stripe read, a failed send and the switch-on count,
      with no client name or contact. A one-time switch-on script under server/scripts/ that pages through
      Stripe's disputes, records only those not closed (booking 843's two closed ones are never backfilled)
      and shares the handler's upsert and alert claim. The live endpoint subscription is a rollout step with
      the owner's yes, never part of the code.
    footprint:
      - server/db/schema.sql (the dispute table and its index, appended)
      - server/routes/stripeWebhook.js (three routes)
      - server/routes/stripeWebhookHandlers/disputeAlerts.js (new; the upsert, the claim and the open alert)
      - server/utils/disputeAlertPass.js (new; the daily pass)
      - server/utils/stripeDailySweeps.js (new; runs the payout sweep, then the dispute pass)
      - server/index.js (the stripe_payout_sweep block's require and call only; 989 lines, net zero)
      - server/scripts/disputeSwitchOn.js (new)
      - ARCHITECTURE.md (the webhook prose gaining the dispute record), README.md (generated sections)
      - new tests beside each new file and the dispatcher
    blockedBy: []
    lenses: outcomes-providers, access-egress, concurrency, schema-data, business-time, lifecycle, seams, verify; the full set plus the second opinion, since this is a webhook path.
    laws: >
      Law 12 (the reminder window is the Chicago business day through chicagoTodayYmd, never SQL
      CURRENT_DATE); law 15 (no booking, invoice or tip write; the legal-hold booking is not skipped, since the
      handler and the pass write only the dispute table and email only admins); the Stripe wrapper invariant
      (reads through stripeClient.js); the event-type label invariant (getEventTypeLabel, 'event' as the
      fallback; client name and event type never joined into a title); the public-repo PII rule (Sentry gets
      ids, never a client name or contact); the webhook test-mode drop (the dispatcher's existing gate covers
      the new routes).
    test plan: >
      Pure suites for the ordering rule and the reminder window (Chicago dates; a deadline 2, 3 and 4 days
      out, a null deadline, a past one). DB-backed suites for the handler: created then updated then closed;
      the same three out of order; two events in the same second; two handlers racing on one dispute id on
      two connections (one open alert, the row in the later status); a closed event first and an under-review
      event first (recorded, no alert); a dispute first seen after its deadline (the open alert still goes,
      with the deadline as Stripe gave it; no reminder); the email's fields asserted against a stubbed
      notifyAdminCategory; a failed send (no stamp) then the pass's retry; a tip dispute; an unmatched charge;
      a dispute on the legal-hold booking (recorded and emailed, no booking table touched). The pass with a
      stubbed Stripe through the getStripe seam: still waiting (sends, stamps), under review (updates, no
      send), read failure (sends once, stamps), and a throwing payout sweep leaving the dispute pass to run.
      The switch-on script against a stubbed paginated list (closed ones skipped, no double alert beside a
      live event). Then the stripeWebhook and stripePayoutSync suites.
  - id: dispute-inbox-item
    status: planned
    scope: >
      Spec 5.5's Inbox paragraph. Declared input: the Inbox design artifact,
      docs/design-artifacts/2026-10-06-inbox/, and the menu-task item already built from it (spec 2026-10-19
      section 13). A reader of the dispute table under the booking's client, on the menu-task precedent: open
      while Stripe says the dispute waits on evidence, gone from the waiting list once it is under review, in
      the closed list marked won or lost once closed. Never sent to the Inbox AI read. The Inbox's existing
      hold handling. Tip and unmatched disputes have no item. The row, the thread line and the link reuse the
      menu-task vocabulary with no new visual element; the lane names which existing element carries the
      deadline and the won or lost mark, and a dispute task never borrows the menu task's wording (Done's
      "still waiting on the menu").
    footprint:
      - server/utils/inbox/readDisputes.js (new)
      - server/utils/inbox/engine.js (the reader's wiring only; 764 lines, must stay under 1000)
      - server/utils/inbox/rules.js (the dispute task's open and closed rule, beside the menu tasks)
      - server/utils/inbox/payload.js, reasons.js and the AI read selection only if the item's shape or its exclusion needs them
      - client/src/components/inbox/WaitingRows.js, Thread.js, inboxThread.js and ItemActions.js (the dispute task's row, line and link)
      - client/src/components/inbox/useInboxActions.js (only if a dispute task sets has_task)
      - README.md (generated sections); new tests beside the reader, the rules and each client change
    blockedBy: [chargeback-alert]
    lenses: client (judged against the artifact at 320 and 390 wide), seams, access-egress (the Inbox payload), verify.
    laws: the AI wrapper invariant and money law 15 (dispute items never reach the Inbox AI read; the hold handling is the Inbox's own); the event-type label invariant; the design-artifact contract (off-design is a finding).
    test plan: >
      The reader and rules suites beside the menu-task ones (waiting, under review, closed won, closed lost,
      a tip dispute with no item, a held booking under the hold handling, a dispute item absent from the AI
      read selection); client suites for the row, the thread line and the actions (no menu wording). Then the
      inbox server and client suites. Captures at 320 and 390 wide on the dev server with a stubbed dispute.
---

# Netting re-plan: implementation plan

> For agentic workers: this plan is a lane map without code (spec 2026-10-19 D12). Build each lane in its own worktree (`npm run worktree:new -- <id>`), read the spec section it names, write the failing test first, and stop and say so when a change needs a file outside the lane's footprint.

**Goal:** end the money that sits inside `amount_paid` but outside the booking total, remove the extras comp, mint the Balance after a hand-recorded deposit, and alert on every Stripe dispute with a reminder before its deadline and an Inbox item.

**Architecture:** three small money lanes in order (they share files), each closing one door through code paths that already exist; an independent alert lane that adds a dispute record, emails and a daily pass riding the payout sweep; and an Inbox lane after it on the menu-task precedent.

**Tech stack:** Node and Express with raw SQL on Postgres (Neon), `node --test` for server suites, React with react-scripts tests on the client, Stripe through `server/utils/stripeClient.js`, admin email and push through `server/utils/adminNotifications.js`.

**Spec:** `docs/superpowers/specs/2026-11-24-netting-replan-design.md`, revision 3. The plan argues from it; read both.

## Global constraints

- Money is integer cents in code; `proposals` money columns are dollars and are converted at the read.
- Parameterized SQL only; one pooled connection per request (a held client sends every query until release).
- Route handlers use `asyncHandler` and throw `AppError` subclasses; no internals in an error response.
- `isLegalHold` (fail closed) guards every new write path that could touch the legal-hold booking.
- Stripe only through `stripeClient.js`; tests stub it through the `getStripe` seam; the dev box talks to live Stripe, so no suite creates a real dispute, charge or refund.
- Schema changes are idempotent statements in `server/db/schema.sql`.
- No em dashes in client, admin or email copy. Ids only in specs, plans, commits and fixtures; fixture phones and emails in the shapes `scripts/lib/piiShapes.js` allows.
- File-size ratchet: warn at 700 lines, refuse past 1000. Near the line already: `server/index.js` 989 (net zero for this plan), `ProposalDetailPaymentPanel.js` 836, `ConfirmationStep.js` 811, `inbox/engine.js` 764, `submit.js` 750, `stripe.js` 744, `invoices.js` 707.
- Every new file under `server/` or `client/src/` starts with its header comment; `npm run docs` before each commit; no new environment variable in this plan.
- Before any ship: `node scripts/static-checks.js --base origin/main --tip HEAD` exits 0 (a `${...}` inside a query template is refused unless it is an ALL_CAPS constant or `$${n}`).
- DB-backed server suites share the dev database: run them one at a time and read the pass count.
- Client suites: `cd client && npx react-scripts test --watchAll=false <path>`.

## Review focus

The five conditions the spec implies that a lane's tests would miss unless written for them; each one's test is in the owning lane's test plan.

1. A v1 syrup-only submit on a booking with no package, guest count or duration: refused with `SYRUPS_NOT_PRICEABLE`, nothing written. (third-kind-ends)
2. A v1 client whose page loaded a pay-now intent for syrups alone before the deploy: the submit is refused before any write and no charge is confirmed (the page submits before it confirms the payment). (third-kind-ends)
3. Two admins, or a double click, voiding the same extras invoice at once: one void, at most one Additional Services. (extras-void-to-balance)
4. A dispute first seen after its deadline has passed (a late delivery or the switch-on): the open alert still goes with the deadline Stripe gave, and no reminder follows. (chargeback-alert, the handler suite)
5. Two handlers racing on one dispute id: the row ends in the later status and exactly one open alert goes. (chargeback-alert)

---

## Lane 1: third-kind-ends

Spec 5.1 to 5.4 and section 6. Scope, footprint, lenses and laws are in the front matter.

**Interfaces produced:** the 409 codes `SYRUPS_ADD_TO_BALANCE` and `SYRUPS_NOT_PRICEABLE` (create-drink-plan-intent and the submit); `sumOffContractPaidCents(proposalId, dbClient) -> Promise<number>` keeps its signature and now sums only unfolded Drink Plan Extras invoices.

**Tasks:**
1. Re-grep the four symbols of spec section 7 (the `Drink Plan Extras` label, `extrasLinesAreFolded`, `sumOffContractPaidCents`, `offContractPaidCents`) across `server/` and `client/src/`, and write in the lane report, per file, whether it changes and why not when it does not. A reader that must change and is outside the footprint stops the lane until the footprint is amended.
2. Failing suites first: the submit (syrup-only add to balance on a booking with an open Balance, on a fully paid booking, on the legal-hold booking; syrup-only with no package refused with `SYRUPS_NOT_PRICEABLE`; a `paid_separately` syrup-only submit refused with `SYRUPS_ADD_TO_BALANCE`, nothing written), create-drink-plan-intent (syrups alone refused under both payment choices, a mixed request allowed), `sumOffContractPaidCents` (a paid free-text invoice counts 0, booking 599's shape counts its amount), the overpayment derivation (a price drop after a paid hand-made invoice shows the overpayment), ConfirmationStep (syrups alone offer only add to balance; the quote is the pack-aware difference, for example two contract bottles plus one new one quoting the 3-pack price minus two singles), and the panel's create-invoice hint.
3. The submit and intent changes, then the netting change and the header notes, then the client step and the admin hint.
4. Money laws 5 and 7 and the ARCHITECTURE prose near line 3327; the verify pass reads each law against the code before its "Checked against code" line is written; `npm run docs`.
5. The read-only production query of spec 5.2, run before the ship: every booking whose `amount_paid - total_price` exceeds its unfolded extras money while it holds paid free-text money, excluding the legal-hold booking. Expected: no row.

**Acceptance:**
- The lane report carries the task 1 table.
- Each new server suite passes on the lane and fails on main (named in the lane report by file and count); the reached suites and `npm run test:smoke` pass.
- The client suites pass: `cd client && npx react-scripts test --watchAll=false src/pages/plan/steps src/pages/admin/ProposalDetailPaymentPanel`.
- `grep -n "free-text\|Damage Fee" server/utils/invoiceExtras.js` shows no line saying a free-text invoice is outside the contract.
- `docs/money-laws.md` laws 5 and 7 state spec section 6's rule and each carries a "Checked against code" line dated on the lane, written after the verify pass.
- The production query of task 5 returns no row; if it returns any, the lane stops and reports before the ship.
- `node scripts/static-checks.js --base origin/main --tip HEAD` exits 0; `npm run docs` leaves no diff.

## Lane 2: extras-void-to-balance

Spec 5.6. After third-kind-ends merges (shared `invoiceExtras.js` and `ProposalDetailPaymentPanel.js`).

**Interfaces produced:** the void response keeps its shape, plus the id and amount of any Additional Services invoice it minted.

**Tasks:**
1. Failing suites first, as the front matter's test plan lists, including the concurrent void of review focus 3.
2. The route, helper and comment changes; then the void control and its copy.
3. `npm run docs`.

**Acceptance:**
- The new invoices suite passes on the lane and fails on main for the comp and the fully paid cases (named in the lane report).
- The reached suites and `npm run test:smoke` pass; `cd client && npx react-scripts test --watchAll=false src/pages/admin/ProposalDetailPaymentPanel` passes.
- `grep -n "reconcile_total !== false" server/routes/invoices.js` finds nothing.
- Static checks exit 0; `npm run docs` leaves no diff.

## Lane 3: recorded-deposit-balance

Spec 5.7. After extras-void-to-balance merges (shared `invoices.js` and `ProposalDetailPaymentPanel.js`).

**Interfaces produced:** `isAtDeposit(dbClient, proposalId) -> Promise<boolean>` in `server/utils/balanceAtDeposit.js`, read on the caller's client under the caller's lock; the record-payment response gains `balance_invoice: { minted: boolean, reason?: string }`.

**Tasks:**
1. Failing suites first, as the front matter's test plan lists.
2. The helper, the admin Balance route calling it (its existing suites unchanged), record-payment, the panel note.
3. `npm run docs`.

**Acceptance:**
- The new record-payment suite passes on the lane and its deposit case fails on main (named in the lane report).
- The existing admin Balance route suites pass unchanged; the reached suites and `npm run test:smoke` pass; `cd client && npx react-scripts test --watchAll=false src/pages/admin/ProposalDetailPaymentPanel` passes.
- Static checks exit 0; `npm run docs` leaves no diff.

## Lane 4: chargeback-alert

Spec 5.5 without its Inbox paragraph. Independent of lanes 1 to 3.

**Interfaces produced:** the dispute table; `applyDisputeEvent(dbClient, dispute, eventCreatedSeconds) -> Promise<{ row, firstSeenWaiting }>` shared by the handler, the pass and the switch-on script; `sendDisputeOpenAlert(disputeRow) -> Promise<boolean>` (true only on a successful send, behind the atomic claim) shared by the same three; `runStripeDailySweeps() -> Promise<void>` called by the stripe_payout_sweep scheduler.

**Tasks:**
1. The schema, then failing suites for the ordering rule, the claim and the handler (review focus 4 and 5 included).
2. The handler, the open alert and the dispatcher routes.
3. The daily pass and `stripeDailySweeps.js`, the index.js swap, then the switch-on script.
4. The ARCHITECTURE webhook prose; `npm run docs`.

**Acceptance:**
- Every new suite passes; the stripeWebhook and stripePayoutSync suites pass.
- `grep -n "charge.dispute" server/routes/stripeWebhook.js` shows the three new routes by name and the two existing ones, and no wildcard.
- `wc -l server/index.js` is at most 989.
- A read-only production read shows at least one admin account subscribed to `payment_failure`, the owner's included (a count, no contact printed), and the `stripe_payout_sweep` health row shows a run within the last day.
- Static checks exit 0; `npm run docs` leaves no diff.

## Lane 5: dispute-inbox-item

Spec 5.5's Inbox paragraph. After chargeback-alert merges (it reads the dispute table).

**Tasks:**
1. Failing suites first, as the front matter's test plan lists.
2. The reader and rules, then the client row, line and link on the artifact.
3. `npm run docs`.

**Acceptance:**
- Every new suite passes; the inbox server and client suites pass.
- The captures at 320 and 390 wide, judged by the client review against `docs/design-artifacts/2026-10-06-inbox/` and the menu-task item, raise no off-design finding.
- Static checks exit 0; `npm run docs` leaves no diff.

## Rollout (after the lanes ship; spec section 9)

1. With the owner's yes at that time: add `charge.dispute.created`, `charge.dispute.updated` and `charge.dispute.closed` by name to the live endpoint `we_1TCm2cAZrfv5tWfNcqAOhf3x`, keeping its eight events, and read the list back (eleven events, no `funds_*`).
2. Run the switch-on script once; it prints how many open disputes it recorded (expected 0).
3. If chargeback-alert is ever reverted after step 1, tell the owner the alerts stopped, and with his yes remove the three events.
4. Report for the owner's list (spec section 8): an open folded extras invoice beside the total after a declined v1 mixed pay-now card; the Enhancement Lab remainder excluding folded extras invoices; an open hand-made invoice beside an open Balance; a v1 add-on submit on a booking with no package saving the add-ons unbilled. The two items that want their own design (the PRC-03 pricing mismatch and the law-4 fold recompute) are named with them.
