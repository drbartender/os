# Refund scope on the panel and the dashboard path: design

Date: 2026-09-15. Brainstormed in chat with Dallas, then amended after the design-stage fleet (grounding, gaps, risk) returned four blockers. Sensitive paths (money, webhook): full fleet plus the cross-LLM pass before push.

## 1. Problem

Two halves of one gap, both verified against prod and live Stripe on 2026-09-15.

- Refunding a true overpayment from the proposal payment panel lowers `total_price` and `amount_paid` together, so the proposal stays overpaid by the same figure and the contract shrinks on every attempt. `POST /api/stripe/refund/:id` never passes a scope into `refundExecute`, so every panel refund is `contract` scope. All seven refunds ever issued are contract scope.
- A refund issued in the Stripe dashboard never reaches the database. `charge.refunded` is not subscribed on the live endpoint, and it could not have helped as written: the endpoint runs API version `2025-01-27.acacia`, and under that version the Charge object carries no `refunds` list (verified by retrieving `py_3UCM5IAZrfv5tWfN2Ng0PNTg`: `refunded: true`, `amount_refunded: 40000`, no `refunds` key), so `chargeRefunded.js` reads `undefined` and no-ops. Stripe's refunds guide agrees: "Listen to `refund.created` for information about the refund."

Prod exposure today: proposal 784 shows `amount_paid` 900 on a `total_price` of 500, `status` `balance_paid`. Dallas refunded the duplicate 9/5 bank debit from the dashboard on 2026-09-14 (refund `pyr_1UFeeuAZrfv5tWfN2dSmhD8p`, $400, reason `duplicate`, status `pending` at Stripe, on intent `pi_3UCM5IAZrfv5tWfN22fCmUkN`, payment row 375, which carries no `invoice_payments` link). The database never saw it. Proposal 599 (paid 260 on 200, `external_paid` 100) is not an overpayment: the $60 is a paid Drink Plan Extras invoice, and three admin surfaces call it overpaid because they subtract raw columns.

A fix was attempted on 2026-07-26 and reverted: it derived "overpayment" from `amount_paid - total_price` inside reconciliation, which double-subtracts non-contract invoice money. The fix list says do not re-attempt naively. This design derives nothing inside reconciliation. `applyRefundReconciliation` already honors an `overpayment` scope, the row already carries `total_scope` under a CHECK of `('contract', 'overpayment')`, the sweeper and the webhook path already adopt by row scope, and cancel-line already issues `overpayment`. The panel path and the dashboard path are the two callers that never say which.

**The overflow case (fleet, 2026-09-15).** `linkPaymentToInvoice` (`server/utils/invoiceLinking.js:118-121`) caps an invoice credit at that invoice's remaining due and returns the rest as `overflowCents`, while `paymentIntentSucceeded` rolls the **whole** intent into `proposals.amount_paid`. So an overpaying payment is split: part credited to an invoice, part carried only by `amount_paid`. The existing overpayment-scope invoice rule was written for cancel-line, where `refreshUnlockedInvoices` had already corrected the invoice demand inside the same transaction. On the panel path nothing corrects it, and the reversal walks the **credited** links, which is the wrong money: a $900 payment crediting $500 to a locked $500 Balance invoice, refunded $400 as overpayment, leaves that invoice demanding $100 on an unchanged $500 contract. Section 4b fixes this at the source.

## 2. Decisions

- D1 The admin decides the scope on the panel. The derived overpayment figure sets the checkbox default and the cap; it never silently changes what a refund does (Dallas).
- D2 The dashboard path is included: a refund issued in Stripe lands in the database with the right scope (Dallas).
- D3 An overpayment-scope refund is capped at the netted excess. The cap is asserted inside the transaction that writes the pending row, holding the proposals row lock, so two concurrent submits cannot both pass it.
- D4 Under overpayment scope, reconciliation consumes the payment's **uncredited** headroom first and walks invoice links only for the remainder. The planner prefers the payment with the most uncredited headroom **among candidates that can cover the amount**, falling back to largest-remaining so the over-cap message stays true (Dallas approved, 2026-09-15). **Amended after the lane fleet:** absorption alone only fixes the overflow case when the headroom is big enough, so the panel path additionally REFUSES an overpayment refund the target charge cannot cover from uncredited money (`OVERPAYMENT_NOT_ON_A_CHARGE`). Without that, an excess funded outside Stripe, or split so no single charge covers it, still reversed credited invoice money and left a settled invoice demanding less than the contract. That refusal is also how an unreturnable overpayment surfaces: `external_paid` rolls into `amount_paid` with no charge behind it, so there is nothing to send back through Stripe.
- D5 On the dashboard path the scope is `overpayment` when Stripe's `reason` is `duplicate` **or** the netted excess covers the whole refund; otherwise `contract`. A reason string alone never decides a contract-lowering rule (Dallas approved, 2026-09-15). **Amended after the lane fleet:** that decision reads `amount_paid`, so it happens INSIDE the transaction, after `SELECT ... FOR UPDATE` on the proposals row. Read on the pool first it was a read-then-act across a lock boundary: two dashboard refunds seconds apart both saw the same pre-refund excess and both classified as `overpayment`, leaving the contract un-corrected with no warning. Three reviewers found it independently.
- D6 The subscribed event for reconciliation is `refund.created`, whose payload is the Refund object. `charge.refunded` is subscribed too, for the tip clawback only, because `amount_refunded` is on the Charge under every API version. Neither handler depends on the other's order.
- D7 Proposal 784 is healed through the existing pending-row sweeper with a pending `overpayment` row, never by editing money columns by hand.
- D8 No schema change.
- D9 The new handler rethrows on any reconciliation failure, so Stripe sees a 5xx and retries. A dashboard refund has no pending row and the sweeper only selects pending rows, so nothing else backstops it.
- D10 The new handler never adopts a pending row by the (intent, amount) heuristic. It adopts only the row Stripe names in `metadata.proposal_refund_row_id`; otherwise it passes its own scope and suppresses the heuristic. **Amended after the lane fleet:** that row id is externally supplied, and the heuristic it replaces constrained intent AND amount, so an unchecked lookup would carry LESS validation than the path it replaced. The handler validates the named row against this proposal, this intent, this amount and `status = 'pending'` before using it, and falls back to the derived scope when it does not match; `applyRefundReconciliation` independently scopes its by-id lookup to the proposal, so the reconciler does not depend on its caller having checked.
- D11 The handler emails the client only for a refund it cannot attribute to an in-app path (no `proposal_refund_row_id` metadata). A panel or cancel-line refund's notice belongs to the issuing path and its notify-client answer. The gate is the id Stripe **echoed**, not the id that validated: a refund carrying one that fails validation was still issued in-app, so emailing it would send the notice an admin declined.
- D12 Every admin surface that says "overpaid" reads the netted figure. Three do today; all three move.
- D13 A refund in `requires_action` records nothing. Stripe is still collecting bank details from the customer, no money has moved, and it expires to `failed` if they never answer. Unreachable with the pinned checkout methods, so reaching it means a payment method we do not think we accept produced a refund; it is warned, not recorded.

## 3. The netted excess and the payload

Two helpers in `server/utils/refundHelpers.js`, both taking the pool or a held client (required from any in-transaction caller, per the one-connection rule):

```
offContractPaidCents(proposalId, db)  = sumOffContractPaidCents(proposalId, db)
overpaymentCents(proposalId, db)      = max(0, round(amount_paid * 100) - round(total_price * 100) - offContractPaidCents)
```

`sumOffContractPaidCents` (`server/utils/invoiceExtras.js:340`) is the netting cancel-line already uses for its own `overpaymentCents` (`lineItemCancel.js:701-715`, identical formula): paid invoices whose money is not inside `total_price` (Drink Plan Extras when its lines are not folded, manual labels), with Service Extension excluded because it is off both sides. `amount_paid` includes `external_paid`, so the excess can be funded by off-platform money with no Stripe charge behind it; section 5 handles that case in the UI rather than letting the admin discover it at submit.

`GET /api/proposals/:id` (`server/routes/proposals/getOne.js`, `auth, requireAdminOrManager`) adds three derived fields, no schema change:

- `overpayment_cents` — the netted excess. Same semantics and same name as the existing `overpayment_cents` on `POST /api/proposals/:id/cancel-line/preview` (`cancelLineItem.js:87`), deliberately, so the two never read as different figures.
- `off_contract_paid_cents` — the netting term, so the client can net a hypothetical new total without a second round trip.
- `max_refundable_cents` — the largest single-charge Stripe headroom (`max` of `loadPaymentsWithRemaining`'s `remainingCents`), because no refund can span charges.
- `max_overpayment_refundable_cents` — the largest UNCREDITED headroom on any one charge, i.e. how much of the overpayment can actually come back through Stripe. The panel keys its "return it by hand" wording on this, not on `max_refundable_cents`: charges can exist and still be fully credited.

`GET /api/proposals/:id` computes the netting ONCE and derives the overpayment in memory from the proposal row it already holds (`nettedOverpaymentCents`, the pure function `overpaymentCents` and cancel-line both call), rather than re-reading `proposals` and re-running the invoice scan.

## 4. Panel route

`POST /api/stripe/refund/:id` (`server/routes/stripe.js:438`, `auth, adminOnly`) body gains `total_scope`: `'contract'` (default when absent) or `'overpayment'`. Any other value is a 400 `INVALID_SCOPE`.

For `overpayment`:

- The route reads the available overpayment for the rejection message and returns 400 `REFUND_EXCEEDS_OVERPAYMENT` when the amount exceeds it. This read is advisory; the authoritative assertion is below, and both call the SAME `availableOverpaymentCents` helper and the SAME `overpaymentRefusalMessage` builder so they can never name different figures. The message has three branches, and the distinction is load-bearing: when the shortfall comes from a refund already in flight it says so and says NOT to uncheck the box, because "this proposal is not overpaid, uncheck the box" would steer the admin onto the contract path, which carries no cap and would shrink the contract by the amount already being returned. A malformed amount is left to `planRefund`'s `INVALID_AMOUNT` rather than reported as an overpayment problem.
- 400 `OVERPAYMENT_NOT_ON_A_CHARGE` when the amount exceeds the target charge's uncredited headroom (D4), naming how much, if any, can be returned that way.
- `refundExecute` gains `enforceOverpaymentCap` (default false, so cancel-line is byte-identical). When true, its step 1 runs in a transaction: `SELECT ... FROM proposals WHERE id = $1 FOR UPDATE`, recompute

  ```
  availableExcess = overpaymentCents(proposalId, client)
                  - Σ amount of PENDING overpayment-scope proposal_refunds on this proposal
  ```

  and throw `AppError('…', 400, 'REFUND_EXCEEDS_OVERPAYMENT')` when `amountCents > availableExcess`; otherwise INSERT the pending row and COMMIT. Succeeded refunds need no netting term: they already lowered `amount_paid`. Because the row is written under the same lock, a second concurrent submit sees the first as a pending overpayment refund and is refused. Nothing is sent to Stripe before this commits.
- `planRefund` gains a `scope`, from which `preferUncredited` is DERIVED rather than passed independently: the refusal above judges the chosen target, so a caller asking for overpayment scope without the preference would be refused against a charge the planner never preferred. `loadPaymentsWithRemaining` returns `uncreditedCents` per payment alongside `remainingCents`:

  ```
  uncreditedCents = max(0, pp.amount
                           - COALESCE(Σ invoice_payments.amount for this payment, 0)
                           - COALESCE(Σ succeeded+pending proposal_refunds.amount for this payment, 0))
  ```

  With the option on, candidates that can cover the amount (`remainingCents >= amountCents`) sort by `uncreditedCents` desc, then `remainingCents` desc, then id asc. **If no candidate can cover it, the target falls back to largest-remaining**, so the existing `EXCEEDS_SINGLE_CHARGE` message ("Largest refundable payment is $X") keeps naming the true maximum. Without the option the order is largest-remaining then id asc, which also makes today's unordered tie deterministic.
- `totalPriceAfterDollars`: `planRefund` gains a `scope` input and returns `totalPriceAfterDollars === totalPriceDollars` for overpayment scope. Reconciliation overwrites it either way; this only keeps the pending row's audit snapshot honest if the refund never reconciles.

`GET /api/stripe/refunds/:id` adds `total_scope` to each row. The refund route's reply shape is unchanged.

## 4b. Reconciliation: uncredited headroom first

In `applyRefundReconciliation` (`server/utils/refundHelpers.js`), under `scope === 'overpayment'` only, before the invoice walk:

```
netCredited  = Σ invoice_payments.amount for this payment   (reversals are negative rows)
priorRefunds = Σ succeeded proposal_refunds.amount for this payment (excluding this one)
headroom     = max(0, pp.amount - netCredited - priorRefunds)
absorbed     = min(amountCents, headroom)
```

The invoice walk then starts at `remaining = amountCents - absorbed`. Everything else is unchanged: `contractCents` stays 0 under overpayment scope, `paidDropCents` stays `amountCents - offLedgerCents`, and absorbed cents leave `amount_paid` exactly as they entered it.

Why the formula is the whole rule: a refund either absorbs headroom or reverses an invoice link, so `priorRefunds - Σ(reversals)` is the headroom already consumed, and `pp.amount - netCredited - priorRefunds` collapses to headroom remaining. A second overpayment refund on the same payment therefore finds zero headroom and correctly reverses links.

Skipped when the payment carries an off-ledger invoice link (the same anti-join `loadPaymentsWithRemaining` uses). Extension invoices are minted alone and paid alone, so their headroom is structurally zero; the guard makes it explicit rather than relying on that.

Absorption alone is CONDITIONAL on the headroom covering the refund; the route-level `OVERPAYMENT_NOT_ON_A_CHARGE` refusal (section 4) is what makes the rule complete on the panel path.

Cancel-line keeps its behavior because its payments are normally fully credited, so headroom is zero and the walk runs exactly as today; the existing RC1 fixtures pin that. This is a property of its data, not a structural guarantee: a drink-plan-rail payment that overflowed its invoice would absorb headroom on that path too, which is strictly better there (it avoids the phantom `partially_paid` balance the old walk produced). Cancel-line does not pass through `planRefund`, so the refusal never applies to it.

The `refund_issued` activity row gains `total_scope` in its details, so an overpayment refund is distinguishable in the audit log from an all-non-contract contract-scope one.

## 5. Panel and the other overpaid surfaces

`client/src/pages/admin/ProposalDetailPaymentPanel.js` (mounted from both `ProposalDetail.js` and `EventDetailPage.js`, both fed by `GET /proposals/:id`):

- The "Overpaid" chip reads `overpayment_cents` instead of `amountPaid > totalPrice`. Proposal 599 stops reading overpaid.
- When `max_refundable_cents` is 0, the Issue refund button is replaced by "No Stripe payment on this proposal can be refunded. Return this by hand." This is the `external_paid` case and the fully-refunded case; both are dead ends today that the admin discovers only at submit.
- When `overpayment_cents` is positive, a checkbox renders under the amount field, checked by default: "This returns an overpayment. The contract total stays at $T," where T is the current `total_price`. When it is zero the checkbox does not render and the scope is contract. The checkbox is disabled while `issuingRefund`, like the confirm button.
- Client-side, an overpayment amount above `overpayment_cents` (or any amount above `max_refundable_cents`) is refused before the notify-client modal opens, with the same wording the server uses, so the admin is not asked about emailing a refund the server will reject.
- The refund history line appends "overpayment" for rows with that scope.

`client/src/pages/admin/proposalEditor/repriceSummary.js` takes `offContractPaidCents` and nets it in both derivations (`wasOverpaid` at `:35`, and the "Client is now overpaid by $X. A refund is likely owed." line at `:91`), whose comment currently cites the panel chip as its source of truth.

`server/routes/proposals/crud.js:625-633` writes an `overpayment_detected` activity row from `reconcileProposalPaymentStatus`'s raw `overpaid`. `reconcileProposalPaymentStatus` is pure and stays pure; the caller nets `offContractPaidCents` (it already holds a transaction client) before deciding to log, and logs the netted figure. Its status decision is untouched.

No em dashes in copy. No Visual contract: a checkbox, a history tag and two chip predicates, all in existing admin styles.

## 6. Dashboard path

New handler `server/routes/stripeWebhookHandlers/refundCreated.js`, dispatched on `event.type === 'refund.created'` in `server/routes/stripeWebhook.js` beside the other branches. `event.data.object` is the Refund.

1. `refund.payment_intent` absent (a legacy Charges-API refund): Sentry-warn and return. A NULL-intent refund row is exactly the class the sweeper warns is unadoptable.
2. Resolve the proposal: `refund.metadata.proposal_id` when present, else `proposal_payments` by intent. No proposal (a tip refund, a foreign charge): return, the dispatcher acks.
3. `refund.status` `failed` or `canceled`: return. `pending` and `succeeded` both reconcile, matching what the sweeper adopts today, because a bank refund is `pending` for days.
4. Resolve the succeeded `proposal_payments` row for the intent. **No row: Sentry-warn and return without reconciling.** Reconciling with a null payment id skips the whole invoice walk, which would drop `total_price` by the full amount with no non-contract and no off-ledger netting, the most destructive branch available.
5. Open the transaction and take `SELECT ... FOR UPDATE` on the proposals row BEFORE deciding anything (D5). Then: when `refund.metadata.proposal_refund_row_id` names a row that matches this proposal, this intent, this amount and `status = 'pending'`, pass it as `pendingRowId` and let the row's `total_scope` win. Otherwise pass `allowPendingHeuristic: false` (new option on `applyRefundReconciliation`, default true so no existing caller changes) and an explicit scope per D5, computed on the held client: `overpayment` when `refund.reason === 'duplicate'` or the netted excess covers the refund, else `contract`. `applyRefundReconciliation` re-locks the same row inside the same transaction, which is free.
6. `applyRefundReconciliation` in one transaction: `stripeRefundId: refund.id`, `amountCents: refund.amount`, `reason: 'Refunded via Stripe dashboard (<stripe reason, or "no reason given">)'`, `issuedBy: null`. Idempotent by refund id through the existing partial unique index, so a redelivery, the panel route and the sweeper cannot double-apply. Any failure rethrows (D9).
7. Release the pooled client, then, per D11, send the client notice only when `recon.applied` and Stripe echoed no `proposal_refund_row_id` at all. `sendRefundClientNotification` takes its own pooled connection and runs the existing suppression gate.
8. Sentry warnings, ids and cents only, never a name or an address: a contract-scope refund landing on a proposal whose netted excess is positive (the money rule may be wrong in the shrinking direction), and an overpayment-scope refund larger than the netted excess (the money has already moved, so it applies and the total is corrected in the editor).

`chargeRefunded.js` drops its reconciliation half, which cannot run under this API version, and keeps `clawbackTipByPaymentIntent(paymentIntentId, charge.amount_refunded)`. Subscribing `charge.refunded` makes the tip clawback live for a dashboard refund of a tip for the first time.

**Service Extension refunds keep working.** An extension payment does get a `proposal_payments` row (`paymentIntentSucceeded.js:88-96`, the insert runs before the extension discriminator), so step 4 resolves; D5 lands it `contract` (an extension's money is not in `amount_paid`, so the excess is zero), and that is harmless because `Service Extension` is not in `CONTRACT_LABELS`: `nonContractCents` equals the full amount, `contractCents` is 0, `offLedgerCents` keeps `amount_paid` still. `docs/ops-runbook.md:86-90` names `charge.refunded` as the reconciler and must be rewritten to name `refund.created`.

## 7. Proposal 784 (DONE 2026-09-15)

Applied and verified: the pending `overpayment` row was inserted, the prod sweeper adopted it against Stripe refund `pyr_1UFeeuAZrfv5tWfN2dSmhD8p`, and proposal 784 now reads `total_price` 500, `amount_paid` 500, status `balance_paid`, with both invoices untouched and `contract_cents` 0 in the activity row. No client email was sent (`email_status` is `bad`). The procedure that ran:

Healed with existing machinery, independent of the code above, after this spec's review. One guarded insert through the Neon route, conditional on no `proposal_refunds` row for that intent:

```
INSERT INTO proposal_refunds
  (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
   total_price_before, total_price_after, issued_by, status, total_scope, created_at)
VALUES
  (784, 375, 'pi_3UCM5IAZrfv5tWfN22fCmUkN', 40000,
   'Duplicate bank debit of the Balance, refunded from the Stripe dashboard 2026-09-14',
   500, 500, NULL, 'pending', 'overpayment', '2026-09-14T18:31:16Z');
```

`created_at` is the Stripe refund's own time, so the sweeper's 30-minute age gate is already past. The refund pending sweep runs every 15 minutes in prod (healthy, last run 07:30 UTC today). Verified preconditions, 2026-09-15: proposal 784 has zero `proposal_refunds` rows, Stripe has exactly one refund on that intent, and payment 375 carries zero `invoice_payments` links. So the sweeper's unique-amount fallback matches unambiguously, and the outcome is identical under today's reconciliation and under section 4b (zero credited means the whole refund is headroom): `amount_paid` 900 to 500, `total_price` stays 500, status stays `balance_paid` because paid still covers the total, no invoice moves. The client's `email_status` is `bad` (verified), so `shouldSendImmediate` returns `bad_contact` and the sweeper's notice is suppressed. Verified afterwards by reading the proposal row and the refund row (`status = 'succeeded'`, `stripe_refund_id = 'pyr_1UFeeuAZrfv5tWfN2dSmhD8p'`).

Subscriptions are not retroactive, so the already-created refund does not re-fire and nothing races the sweeper.

## 8. Tests

- `refundHelpers`: `overpaymentCents` nets an unfolded Drink Plan Extras invoice and a manual label, ignores a Service Extension, floors at zero; `planRefund` with `preferUncredited` picks the most-uncredited covering candidate, falls back to largest-remaining when none covers (and the `EXCEEDS_SINGLE_CHARGE` figure is the true maximum), and is deterministic on a tie without the option. Re-run `refundHelpers.test.js`, which pins "auto-target picks the largest-remaining charge" (`:24`) and the no-spanning rejection (`:50`).
- Reconciliation (`refundHelpers.scope.test.js`): the overflow case end to end (a payment crediting part of a locked invoice, overpayment refund inside the headroom, invoice untouched, `total_price` untouched, `amount_paid` down); a second overpayment refund on the same payment finds no headroom and reverses links; the off-ledger-linked payment skips absorption; the RC1 unlocked and locked fixtures still pass unchanged.
- Route (new `server/routes/stripe.refundScope.test.js`): unknown scope 400; over-cap 400 with the message; within-cap lands `overpayment` and leaves `total_price`; contract scope unchanged; history returns `total_scope`; two concurrent overpayment submits, one wins and one is refused by the locked assertion.
- Webhook (new `server/routes/stripeWebhook.refundCreated.test.js`): adopts a pending row by metadata and keeps its scope; a `duplicate` dashboard refund lands overpayment; a `requested_by_customer` refund on an overpaid proposal lands overpayment via the excess and warns nothing; the same reason on a not-overpaid proposal lands contract; a stranded same-amount pending row is NOT adopted; `failed` skipped; no payment row skipped; no proposal is a no-op; redelivery applies once; a reconciliation failure rethrows so the delivery 5xxs; no client email when the refund carries a row-id. `chargeRefunded` pinned to the clawback alone.
- Client (new `ProposalDetailPaymentPanel.refund.test.js`): checkbox present and checked when overpaid, absent when not, request carries the scope, chip reads the netted figure, the zero-headroom line replaces the button; `repriceSummary` nets off-contract money.
- Re-run: `refundExecute`, `refundSweepScheduler`, `proposals/cancel`, `cancelLineItem`, `stripe.webhook`, `refundHelpers.override`, `refundHelpers.extensionScope`, `refundHelpers.splits`.

## 9. Rollout and docs

1. Push after the full fleet and the cross-LLM pass; Render deploys.
2. Subscribe the live endpoint `we_1TCm2cAZrfv5tWfNcqAOhf3x` to `refund.created` and `charge.refunded`, from this box, and read it back. The current set is six events, read back on 2026-09-15 after the bank-debit rollout; the build board line calling that subscription still owed is stale and is corrected in the same edit.
3. The 784 heal (section 7) runs after this spec's review and does not wait for the deploy.
4. `scripts/money-smoke-list.txt` gains the two new money suites, so the push gate covers the overpayment cap, the concurrent-submit lock assertion and the dashboard reconciler, not just the helper derivations.
5. Docs: `docs/ops-runbook.md:86-90` (the extension refund procedure names the new event); `README.md` folder tree (new handler line, and `chargeRefunded.js` redescribed as tip clawback only) plus `README.md:812` ("`charge.refunded` webhook-backstopped"); `ARCHITECTURE.md:411` (route table event list), `:1189` (idempotency anchor note), `:1976` (webhook event list), `:1979` (partial refunds narrative); the stale `charge.refunded`-as-backstop comments in `server/utils/refundExecute.js` and `server/routes/stripe.js`; the fix list (close "Refunding a true overpayment shrinks the contract", amend the cancel-line manual-recovery note that exists only because of this bug, note that RC4's row-id adoption now reaches the webhook path, add the residuals below); `docs/walkthroughs-owed.md` (first panel overpayment refund, first dashboard refund landing).

## 10. Out of scope, recorded as residuals

- A bank refund reconciled at `pending` that later fails at the bank leaves a `succeeded` row and, for a tip, a clawback that only moves forward. Both need `refund.failed` and reverse paths that do not exist. Same shape as the bounced-debit problem closed 2026-09-14.
- The client notice ignores the admin's notify-client answer on any path that adopts a pending row (the sweeper today, the new handler's metadata case). Fixing it needs the answer carried on the refund row, which is a schema change. Pre-existing for the sweeper; the new handler stays silent rather than guessing, so the failure mode is a missed notice, never an unwanted one.
- A dashboard refund whose netted excess is positive but smaller than the refund lands `contract` and over-shrinks the total by the excess portion. Sentry warns with both figures; the admin corrects the total in the editor.
- After D10, no caller reaches `applyRefundReconciliation`'s (intent, amount) pending heuristic. Removing it is a follow-up, not part of this change.
- The panel is reachable by managers (`GET /proposals/:id` is `requireAdminOrManager`) while the refund route is `adminOnly`, so a manager sees a button the server refuses. Pre-existing; noted, not changed here.
- The provenance boolean on invoices (the fix-list root cause behind every netting classifier), a gratuity scope, splitting one refund across two scopes, and dispute subscriptions. A dashboard refund that is PART excess and part contract correction therefore lands wholly on one rule; scope is binary under the existing CHECK, and splitting it needs a schema change.
- The overpayment cap nets only PENDING OVERPAYMENT refunds. A concurrent contract-scope refund against a non-contract-labeled invoice consumes excess without lowering the total, and cancel-line does not enforce the cap at all, so the two can overshoot when genuinely concurrent. Bounded by per-charge headroom and Stripe's own cap, and it fails in the safe direction (status demotes, autopay disarms, recoverable in the editor). On the fix list.
- `proposal_refunds(payment_id)` is unindexed and the lane doubles the per-row scans on it. Eight rows in prod, so textbook rather than real; on the fix list with the exact statement.
- Three files crossed the 700-line soft cap (`refundHelpers.js`, `ProposalDetailPaymentPanel.js`, `stripe.js`). On the fix list with the natural split line.

## Visual contract

None. The form and chip use the existing admin panel styles.
