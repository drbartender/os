# Refund scope on the panel and the dashboard path: design

Date: 2026-09-15. Bounded change, brainstormed in chat with Dallas. This file exists so the design-stage fleet has an artifact and the money rules are on record. Sensitive paths (money, webhook): full fleet plus the cross-LLM pass before push.

## 1. Problem

Two halves of one gap, both verified against prod and live Stripe on 2026-09-15.

- Refunding a true overpayment from the proposal payment panel lowers `total_price` and `amount_paid` together, so the proposal stays overpaid by the same figure and the contract shrinks on every attempt. `POST /api/stripe/refund/:id` never passes a scope into `refundExecute`, so every panel refund is `contract` scope. All seven refunds ever issued are contract scope.
- A refund issued in the Stripe dashboard never reaches the database. `charge.refunded` is not subscribed on the live endpoint, and it could not have helped as written: the endpoint runs API version `2025-01-27.acacia`, and under that version the Charge object carries no `refunds` list (verified by retrieving `py_3UCM5IAZrfv5tWfN2Ng0PNTg`: `refunded: true`, `amount_refunded: 40000`, no `refunds` key), so `chargeRefunded.js` reads `undefined` and no-ops. Stripe's refunds guide says the same: "Listen to `refund.created` for information about the refund."

Prod exposure today: proposal 784 shows `amount_paid` 900 on a `total_price` of 500, `status` `balance_paid`. Dallas refunded the duplicate 9/5 bank debit from the dashboard on 2026-09-14 (refund `pyr_1UFeeuAZrfv5tWfN2dSmhD8p`, $400, reason `duplicate`, status `pending` at Stripe, on intent `pi_3UCM5IAZrfv5tWfN22fCmUkN`, payment row 375, which has no `invoice_payments` link). The database never saw it. Proposal 599 (paid 260 on 200, `external_paid` 100) is not an overpayment: the $60 is a paid Drink Plan Extras invoice, and the panel chip wrongly calls it overpaid because the chip subtracts raw columns.

A fix was attempted on 2026-07-26 and reverted: it derived "overpayment" from `amount_paid - total_price` inside reconciliation, which double-subtracts non-contract invoice money. The fix list says do not re-attempt naively. This design derives nothing inside reconciliation. `applyRefundReconciliation` already honors an `overpayment` scope (contract portion zeroed, `amount_paid` drops by the full refund, invoices reversed per the locked and total-tracking rules), the row already carries `total_scope` under a CHECK of `('contract', 'overpayment')`, the sweeper and the webhook path already adopt by row scope, and cancel-line already issues `overpayment`. The panel path and the dashboard path are the two callers that never say which.

## 2. Decisions

- D1 The admin decides the scope on the panel. The derived overpayment figure sets the checkbox default and the cap; it never silently changes what a refund does (Dallas, 2026-09-15).
- D2 The dashboard path is included: a refund issued in Stripe lands in the database with the right scope (Dallas, 2026-09-15).
- D3 On the panel path an overpayment-scope refund larger than the netted excess is refused with a plain message. The scope can never hide a contract correction.
- D4 Under overpayment scope the planner prefers a payment with no invoice link, so refunding a duplicate leaves the real balance payment and its invoice untouched.
- D5 On the dashboard path the scope comes from the pending row when one exists (a panel refund whose sync reconciliation failed), otherwise from Stripe's own `reason`: `duplicate` means `overpayment`, anything else means `contract`.
- D6 The subscribed event for reconciliation is `refund.created`, whose payload is the Refund object. `charge.refunded` is subscribed as well, for the tip clawback only, because `amount_refunded` is on the Charge under every API version. The two handlers do not depend on each other's order.
- D7 Proposal 784 is healed through the existing pending-row sweeper with a pending `overpayment` row, never by editing money columns by hand.
- D8 No schema change.

## 3. The netted excess

One helper, `overpaymentCents(proposalId, dbClient)` in `server/utils/refundHelpers.js`:

```
max(0, round(amount_paid * 100) - round(total_price * 100) - sumOffContractPaidCents(proposalId, dbClient))
```

`sumOffContractPaidCents` (`server/utils/invoiceExtras.js`) is the netting cancel-line already uses for its `overpaymentCents`: paid invoices whose money is not inside `total_price` (Drink Plan Extras when its lines are not folded, manual labels), with Service Extension excluded because it is off both sides. `amount_paid` includes `external_paid`, same as the cancel-line figure. The helper takes the pool or a held client, like its neighbours.

Consumers:

- `GET /api/proposals/:id` (admin, `server/routes/proposals/getOne.js`) adds `overpayment_cents`.
- The panel chip reads it: "Overpaid $X, issue a refund" shows only when it is positive. Today the chip flags 599.
- The refund route uses it for the D3 cap.

## 4. Panel route

`POST /api/stripe/refund/:id` (`server/routes/stripe.js`) body gains `total_scope`, `'contract'` (default when absent) or `'overpayment'`; any other value is a 400 `INVALID_SCOPE`.

For `overpayment`:

- `amountCents > overpaymentCents` is refused with 400 `REFUND_EXCEEDS_OVERPAYMENT`: "This proposal is overpaid by $X. Refund up to $X as an overpayment, or uncheck the box to correct the contract instead." With an excess of zero the same code fires for any amount.
- `planRefund` gains an option `preferUnlinked`. `loadPaymentsWithRemaining` returns a `linked` flag per payment (EXISTS `invoice_payments` for that payment id). With the option on, candidates sort unlinked first, then largest remaining, then id ascending. Without it, the order is largest remaining then id ascending, so a tie is deterministic on both paths (today a tie is unordered).
- `refundExecute` receives `totalScope`; the pending row carries it from the first insert, so the sweeper and the webhook adopt the same rule. `totalPriceAfterDollars` preview equals `totalPriceBeforeDollars` for overpayment scope; reconciliation overwrites it either way.

`GET /api/stripe/refunds/:id` adds `total_scope` to each row.

The reply shape of the refund route is unchanged.

## 5. Panel

`client/src/pages/admin/ProposalDetailPaymentPanel.js`, the Issue refund form:

- When `overpayment_cents` is positive, a checkbox renders under the amount field, checked by default: "This returns an overpayment. The contract total stays at $T." where T is the current `total_price`. When it is zero the checkbox does not render and the scope is contract; there is nothing to decide.
- The request carries `total_scope` from the checkbox.
- The refund history line appends "overpayment" for rows with that scope, so a past refund reads as what it was. Contract rows read as today.
- The chip switches from `amount_paid > total_price` to `overpayment_cents > 0`.

No em dashes in copy. No Visual contract: the form uses the existing panel inputs and the existing chip.

## 6. Dashboard path

New handler `server/routes/stripeWebhookHandlers/refundCreated.js`, dispatched on `event.type === 'refund.created'` in `server/routes/stripeWebhook.js` next to the other branches. `event.data.object` is the Refund.

1. Resolve the proposal: `refund.metadata.proposal_id` when present (panel refunds stamp it), else `proposal_payments` by `refund.payment_intent`. No proposal (a tip refund, a foreign charge): return, the dispatcher acks.
2. `refund.status` `failed` or `canceled`: return. `pending` and `succeeded` both reconcile, matching what the sweeper adopts today (a bank refund is `pending` for days).
3. Scope per D5: `pendingRowId` from `refund.metadata.proposal_refund_row_id` when present; the row's scope wins inside reconciliation. Otherwise `totalScope` is `'overpayment'` when `refund.reason === 'duplicate'`, else `'contract'`.
4. `applyRefundReconciliation` inside one transaction with `stripeRefundId: refund.id`, `paymentIntentId`, `paymentId` (the succeeded `proposal_payments` row for the intent, or null), `amountCents: refund.amount`, `reason: 'Refunded via Stripe dashboard (<stripe reason or no reason given>)'`, `issuedBy: null`. Idempotent by refund id through the existing unique index, so a redelivery, a panel refund's own event, and the sweeper cannot double-apply.
5. Post-commit, the client refund notice when `recon.applied` (email-only, through the existing suppression gate), same as the sweeper.
6. Overpayment scope larger than the netted excess on this path cannot be refused, the money has moved. Apply as overpayment and raise a Sentry warning with the figures so the total can be corrected in the editor. Rare by construction: a dashboard refund tagged duplicate is a duplicate.

`chargeRefunded.js` drops its reconciliation half, which cannot run under this API version, and keeps the tip clawback (`clawbackTipByPaymentIntent(paymentIntentId, charge.amount_refunded)`). Subscribing `charge.refunded` therefore also makes the tip clawback live for a dashboard refund of a tip, which is what it was built for and has never fired.

## 7. Proposal 784

Healed with the existing machinery, independent of the code above, after this spec's review. One guarded insert through the Neon route, conditional on no `proposal_refunds` row for that intent:

```
INSERT INTO proposal_refunds
  (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
   total_price_before, total_price_after, issued_by, status, total_scope, created_at)
VALUES
  (784, 375, 'pi_3UCM5IAZrfv5tWfN22fCmUkN', 40000,
   'Duplicate bank debit of the Balance, refunded from the Stripe dashboard 2026-09-14',
   500, 500, NULL, 'pending', 'overpayment', '2026-09-14T18:31:16Z');
```

`created_at` is the Stripe refund's own time, so the sweeper's 30-minute age gate is already past. The refund pending sweep runs every 15 minutes in prod (healthy, last run 07:30 UTC today). It lists the intent's refunds, finds exactly one unrecorded $400 refund, and adopts it through `applyRefundReconciliation` with the row's `overpayment` scope: `amount_paid` 900 to 500, `total_price` stays 500, status stays `balance_paid` (paid still covers the total), payment 375 has no invoice link so no invoice moves, and no email goes out because the client's address is flagged `bad` from the earlier bounce. Verified afterwards by reading the proposal row and the refund row (`status = 'succeeded'`, `stripe_refund_id = 'pyr_1UFeeuAZrfv5tWfN2dSmhD8p'`). Once `refund.created` is subscribed the old refund does not re-fire, so nothing races the sweeper.

## 8. Tests

- `refundHelpers`: `overpaymentCents` nets a paid unfolded Drink Plan Extras invoice and a manual-label invoice, ignores a Service Extension, floors at zero; `planRefund` with `preferUnlinked` picks the unlinked payment on a same-amount tie and is deterministic without it.
- Route (new `server/routes/stripe.refundScope.test.js`): unknown scope 400; overpayment over the excess 400 with the message; overpayment within the excess reaches the row as `overpayment` and leaves `total_price` alone; contract scope unchanged; history returns `total_scope`.
- Webhook (new `server/routes/stripeWebhook.refundCreated.test.js`): adopts a pending row by metadata and keeps its scope; a dashboard `duplicate` refund lands as overpayment; another reason lands as contract; `failed` status skipped; no proposal is a no-op; redelivery applies once. `chargeRefunded` test pinned to the clawback alone.
- Client (new `client/src/pages/admin/ProposalDetailPaymentPanel.refund.test.js`): checkbox present and checked when overpaid, absent when not, request carries the scope, chip reads the netted figure.
- Re-run: `refundHelpers.scope`, `refundHelpers.splits`, `refundHelpers.override`, `refundHelpers.extensionScope`, `refundExecute`, `refundSweepScheduler`, `proposals/cancel`, `cancelLineItem`, `stripe.webhook`.

## 9. Rollout and docs

1. Push after the full fleet and the cross-LLM pass; Render deploys.
2. Subscribe the live endpoint `we_1TCm2cAZrfv5tWfNcqAOhf3x` to `refund.created` and `charge.refunded` on top of the six current events, from this box, and read it back.
3. The 784 heal (section 7) runs after this spec's review and does not wait for the deploy.
4. Docs: ARCHITECTURE (route body field, the new event and handler), README (endpoint event list), the fix list (close "Refunding a true overpayment shrinks the contract", amend the related cancel-line recovery note, add the residual below), walkthroughs-owed (first panel overpayment refund, first dashboard refund landing).

## 10. Out of scope

- A bank refund that fails at the bank days after it was created leaves a `succeeded` row behind. Needs `refund.failed` and a reverse reconciliation that does not exist. Recorded on the fix list as a residual; same shape as the bounced-debit problem closed on 2026-09-14.
- The provenance boolean on invoices (the fix-list root cause for every netting classifier). The netting helper is reused as is.
- A gratuity scope, and splitting one refund across two scopes.
- Dispute subscriptions.

## Visual contract

None. The form and chip use the existing admin panel styles.
