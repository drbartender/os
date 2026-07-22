# Balance-invoice monitor

**Date:** 2026-07-21
**Status:** design rev 4, cut to alert-only on Dallas's call after two design-fleet rounds
**Base:** main @ 0dbb8ee

## The invariant

> Everything a booked client owes must be payable somewhere.

The monitor detects violations and tells a human. It never creates, edits, or voids an invoice.

## Problem

A `confirmed` proposal's public page has no sign-and-pay affordance. Its only pay control is the "Pay balance" button, which renders only when an open (`sent`/`partially_paid`) invoice exists (`open_invoice_token`, `server/routes/proposals/publicToken.js`; button gate in `client/src/pages/proposal/proposalView/ProposalView.js`). Balance reminders link to the proposal page, never to an invoice, and do not self-suppress while the balance is positive.

Native events always have that open invoice, because the Stripe deposit webhook mints the Balance invoice at deposit time. Any proposal whose deposit did not flow through that webhook (the Check Cherry transfers, or a hand-built proposal confirmed with an externally recorded deposit) has a balance with no payable invoice: the client is dunned toward a page with no way to pay. Eight real clients owed a combined $6,448 in exactly that state and were dunned up to five times each before one of them said something. They were remediated by hand on 2026-07-20 (INV-0204 through INV-0211). The harm was not that the fix was hard (it took minutes); it was that nobody knew for two weeks.

## Decision: detect, do not auto-mint

Revisions 1 through 3 of this spec designed an auto-minting reconciler. Two design-fleet rounds (commits 97cf952, 7b69c58) each found reachable money bugs in it: a double-bill via an open unpaid Deposit invoice, a re-bill via a partially paid unlocked invoice whose `amount_due` a later refresh rewrites, a row lock that is a no-op against the deposit webhook for `confirmed` proposals (the webhook's proposal UPDATE matches zero rows for that status, so it takes no lock), a partial unique index that `initDb` would swallow silently on 23505, a zero-due invoice stealing `open_invoice_token`, and an unthrottled hourly admin email. Every one of those lived in the mint path. None lived in detection.

Alert-only collapses the failure domain: a monitor bug is a spurious or missed email, never a wrong invoice in front of a client. Given zero steady-state volume, a sole operator, and a minutes-long manual fix, that trade is decisively better. The full auto-mint design, with its guard analysis, survives at commit 7b69c58 as the upgrade path if alerts ever become frequent.

## Design

### Module

`server/utils/balanceInvoiceMonitor.js`, exporting `monitorMissingBalanceInvoices()`. It reads `proposals` and `invoices`, and writes only `proposal_activity_log` rows (the escalation record and its notify marker). No invoice writes, no schema changes, no admin-route changes. Returns `{ candidates, alerted, throttled }`.

### Detection

One query:

```sql
SELECT p.id, c.name AS client_name, p.status, p.event_date, p.balance_due_date,
       ROUND(COALESCE(p.total_price, 0) * 100)::int
     - ROUND(COALESCE(p.amount_paid, 0) * 100)::int AS balance_cents
  FROM proposals p
  JOIN clients c ON c.id = p.client_id
 WHERE p.status IN ('confirmed', 'deposit_paid')
   AND ROUND(COALESCE(p.total_price, 0) * 100)::int
     - ROUND(COALESCE(p.amount_paid, 0) * 100)::int
     > COALESCE((
         SELECT SUM(i.amount_due - i.amount_paid)
           FROM invoices i
          WHERE i.proposal_id = p.id
            AND i.status IN ('sent', 'partially_paid')
            AND i.amount_due > i.amount_paid
       ), 0)
 ORDER BY p.id
```

The condition is the invariant itself: the balance due exceeds the total still payable across open invoices. Notes:

- **`status IN ('confirmed','deposit_paid')`**: post-booking only. Quote-stage proposals pay through sign-and-pay; `archived`, `balance_paid`, and `completed` are out of scope (the seven known clientless `completed` orphans are excluded by this filter, and the `JOIN clients` keeps any future clientless row out as well).
- **COALESCE on the money columns**: `total_price` and `amount_paid` are nullable, and a NULL would otherwise make the row silently invisible.
- **Covered, not merely invoiced.** This catches every shape the incident produced or nearly produced: never invoiced (the CC transfers), only-voided Balance (the archive-then-recover shape, since `cancel.js` voids zero-paid invoices), a zero-due open invoice (payable sum contributes 0), and the split shape (Emilene: $200 balance with only a $60 extras invoice open, so 200 > 60 alerts). It stays quiet when an open invoice genuinely carries the balance regardless of label (Iga's `Gratuity Balance`, Brandon's `Additional Services`), which the rev-3 design would have escalated daily.
- **Known false negative, accepted:** an extras-fold tangle where an open non-contract invoice's remainder happens to cover the shortfall can mask a real gap. Classifying that correctly is the rev-3 guard machinery; for an alarm it is not worth the complexity.

### Escalation

Per offending proposal:

- `Sentry.captureMessage('Balance due with no payable invoice (proposal <id>)', { level: 'warning', tags: { scheduler: 'balance_invoice_monitor' }, extra: { proposalId, balanceCents, openInvoiceLabels }, fingerprint: ['balance-invoice-monitor', String(id)] })`, gated on `process.env.SENTRY_DSN_SERVER`.
- One `proposal_activity_log` row, `action: 'balance_invoice_missing'`, `actor_type: 'system'`, details carrying the balance and the labels of any non-void invoices (context for whoever picks it up).

Plus one batched `notifyAdminCategory({ category: 'payment_failure', ... })` email per run covering all newly alerted proposals, **throttled to once per 24 hours per proposal** using `balanceScheduler`'s exact activity-log pattern (send only if no `balance_invoice_missing` row for that proposal with `details->>'admin_notified' = 'true'` exists in the last 24 hours; stamp the marker on send). The throttle is mandatory: a detected proposal stays detected until a human acts, `notifyAdminCategory` has no dedupe of its own, and the Resend quota is shared with client comms. `balanceScheduler`'s comment is the standing rationale: "otherwise a permanently-dead card emails the admin every hour forever."

The email lists each proposal (client, balance, event date, invoice labels present) with an admin link. It is the action item; Sentry is the paper trail.

### When it fires (runbook)

Hand-mint the Balance invoice, as done for INV-0204 through INV-0211: label `Balance`, status `sent`, amount = balance due, line items summing to it, locked for override-priced proposals (their snapshots cannot regenerate the contract price), unlocked for native ones. The admin invoice-create route births invoices as unpayable `draft`s (the parked born-draft trap), so until that is fixed the flip to `sent` happens by SQL.

**Recommended companion, Dallas's call since it un-parks his 2026-07-12 decision:** change `POST /api/invoices/proposal/:proposalId` to birth invoices as `sent` (one word in `server/routes/invoices.js`). With it, the full remediation is doable in the admin UI with no SQL. Without it, the runbook keeps the manual flip.

### Wiring

```js
if (enabled('RUN_BALANCE_INVOICE_MONITOR')) {
  const wrapped = wrapScheduler('balance_invoice_monitor', 3600, monitorMissingBalanceInvoices);
  setTimeout(wrapped, 300000);
  setInterval(wrapped, 60 * 60 * 1000);
} else if (!globalScheduleDisabled) {
  clearHealthRow('balance_invoice_monitor');
}
```

Hourly, staggered off the 30s boot burst. `enabled()` keeps it production-only by default; `RUN_BALANCE_INVOICE_MONITOR=false` is the kill switch. The top-level catch logs, captures to Sentry, and **rethrows**, per the `wrapScheduler` contract in `server/utils/schedulerHealth.js` (without the rethrow, `scheduler_health` reads `ok` while the query fails forever). Every run logs one summary line: `[balance_invoice_monitor] candidates=N alerted=M throttled=K`.

Read-only detection needs no locks and no transaction beyond the two-statement escalation write. Overlapping ticks at worst double-write an activity row inside the same hour; the notify marker check makes the email side idempotent.

## Blast radius

Verified against the prod branch on 2026-07-21: the detection query returns **zero rows** today (all eight CC clients have covering Balance invoices; native events are covered by the webhook; Iga and Brandon are covered by their bespoke-label invoices and correctly stay quiet). First prod run alerting nothing is the deployment gate.

## Testing

`server/utils/balanceInvoiceMonitor.test.js` (shared dev DB, one suite at a time via `node -r dotenv/config`):

1. Alerts: CC shape (confirmed, external deposit, no invoices).
2. Alerts: only-voided Balance invoice.
3. Alerts: split shape (open non-contract invoice smaller than the balance).
4. Alerts: zero-due open invoice only.
5. Quiet: open Balance invoice covering the balance; also a bespoke-label invoice covering it.
6. Quiet: quote-stage, `archived`, `balance_paid`, `completed`, clientless, zero balance, NULL money columns.
7. Throttle: second run within 24h sends no second email; `throttled` counts it.
8. Activity-log row shape, and summary counts match actual alerts.
9. Top-level rethrow records `failed` in scheduler health.

## Documentation updates

- `README.md`: `balanceInvoiceMonitor.js` in the folder tree; `RUN_BALANCE_INVOICE_MONITOR` in the env table.
- `ARCHITECTURE.md`: prose mention alongside `balanceScheduler` in the payments area.
- `.env.example` and the `CLAUDE.md` Environment Variables table: `RUN_BALANCE_INVOICE_MONITOR`.

## Out of scope

- Auto-minting (upgrade path preserved at commit 7b69c58, guards and all, if alerts recur).
- Pointing balance reminders at `/invoice/:token`; post-event AR; the `refreshUnlockedInvoices` vs `lab.js` extras inconsistency; the born-draft trap beyond the one-word companion above.

## Residual risks

1. **A human is the actuator.** The monitor restores knowing, not healing; if the email is ignored, the client stays stuck. That is the accepted trade, and it converts a two-week silent failure into a same-day nudge.
2. **The detection is deliberately label-blind**, so an open non-contract invoice that happens to cover the shortfall masks the gap (rare, and the cost of staying simple).
3. **Email delivery depends on Resend quota**; the 24h throttle bounds the monitor's own contribution, and Sentry remains as the independent channel.
