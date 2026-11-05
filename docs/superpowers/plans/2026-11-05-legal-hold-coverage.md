---
spec: none. The gap was found on 2026-11-05 by the money lens of the menu-bar-legacy-keys overlap pass (the balance charge has no legal-hold refusal) and widened by a read-only code audit of server/ the same night; money law 15 (docs/money-laws.md section 15) is the rule and spec 2026-10-16 section 5.3 the seam's design (server/utils/legalHold.js isLegalHold, the id list LEGAL_HOLD_PROPOSAL_IDS in server/utils/staleProposalSweep.js). The owner asked on 2026-11-05 for the lane to be built. This plan body records the design.
format: lane map without code (spec 2026-10-19 D12)
revision: 1 (2026-11-05)
status: >
  Three lanes. legal-hold-auto and legal-hold-admin are built now, by Claude, each in its own worktree,
  reviewed at the tier it computes (tier A), merged through scripts/merge-lane.sh from os.
  legal-hold-client waits on two owner decisions (below). Main holds menu designer work that must not
  ship before menu-bar-renamed-lines and menu-legal-hold-guards merge, so these lanes ship with it, on
  the owner's word.
lanes:
  - id: legal-hold-auto
    scope: >
      Law 15 says the held proposal is never chased, swept, reconciled or written, and the automatic jobs
      do not ask. Every job below leaves the held proposal out at the query that picks its rows, so it
      reads, writes and sends nothing for it, and the ones that work on shifts, invoices, refunds or
      scheduled messages leave out the rows that belong to it. The ids come from one new helper beside
      isLegalHold, heldProposalIds(), read at call time; a missing list throws, so the run fails and
      writes nothing (fails closed). Jobs: the scheduled-message dispatcher's pending SELECT (a row tied
      to the held proposal directly or through its shift is never selected, never sent and never marked;
      it stays pending); the balance-invoice monitor's two reconciliation SELECTs; the autopay claim and
      the event-completion UPDATE in balanceScheduler.js; the shift-closure sweep; the auto-assign
      scheduler's SELECT; both service-extension sweeps; the stale pending-refund sweep; and balance
      reminder scheduling, which refuses the held id at its entry. The Charge balance route
      (POST /api/stripe/charge-balance/:id) refuses the held id with 409 LEGAL_HOLD before its claim,
      through the patchGuards.js assertNotLegalHold precedent. Several of these are safe today only
      because of the held proposal's status or balance; after this lane none of them depends on its
      data. Left out on purpose: the idempotent boot backfills in server/db/schema.sql (no-ops on old
      rows; a sensitive file replayed at every boot) and the Stripe webhooks (legal-hold-client).
    footprint:
      - server/utils/legalHold.js  (heldProposalIds(), the list for a SQL exclusion; fails closed)
      - server/utils/legalHold.test.js
      - server/utils/scheduledMessageDispatcher.js  (the pending SELECT)
      - server/utils/balanceInvoiceMonitor.js  (OVER_SQL and UNDER_SQL)
      - server/utils/balanceScheduler.js  (processAutopayCharges, processEventCompletions)
      - server/utils/shiftClosureSweep.js
      - server/utils/autoAssignScheduler.js
      - server/utils/serviceExtensionSweep.js  (sweepExpiredExtensions, healUnfinalizedExtensions)
      - server/utils/refundSweepScheduler.js
      - server/utils/balanceReminderScheduling.js  (scheduleBalanceReminders' entry)
      - server/routes/stripe.js  (charge-balance only)
      - one test per changed job beside its existing suite, or a new server/utils/legalHold.jobs.test.js
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: []
    lenses: tier A (balanceScheduler.js, stripe.js and the money paths are sensitive); money (law 15), lifecycle, concurrency, outcomes-providers, access-egress, seams, schema-data if it fires; verify; the externals; the money smoke.
    laws: Money law 15 exactly; integer cents and every existing guard untouched; the exclusion is added beside each job's existing WHERE, never in place of one; no job writes a row to mark a held item skipped; a test adds only synthetic held ids through __setLegalHoldIdsForTest and never reads or writes the real held proposal.
    seams: one helper for every SQL exclusion and isLegalHold for every per-id entry, so the list stays in one place; the dispatcher's existing archived suppression is unchanged; the 409 body is the one the proposal PATCH already answers.
    acceptance: >
      The reached suites and the money smoke pass, and each new test fails on main for its stated reason
      under the review skill's failing-test procedure: on main a synthetic held proposal is selected by
      each job and charged by the Charge balance route.
    test plan: >
      With a synthetic held id: the dispatcher leaves its pending message unsent and unmarked; the monitor
      writes no activity row and sends no email for it; the autopay claim and the completion UPDATE skip
      it; the shift-closure, auto-assign, extension and refund sweeps skip its rows; balance reminders are
      not scheduled for it; the Charge balance route answers 409 LEGAL_HOLD and claims nothing; a missing
      list makes each job throw before any write; an unheld twin of each fixture is still processed.
    revert: revert the one squash commit; no data is written by the change.

  - id: legal-hold-admin
    scope: >
      The admin actions that act on a proposal, its invoice, its shift or its messages refuse the held
      proposal with 409 LEGAL_HOLD before they write, send or call Stripe, through assertNotLegalHold:
      cancel (POST /api/proposals/:id/cancel), the status change (PATCH /:id/status, forced or not), the
      proposal DELETE, the payment link (POST /api/stripe/payment-link/:id), invoice create
      (POST /api/invoices/proposal/:proposalId) and invoice edit or void (PATCH /api/invoices/:id, through
      its proposal_id), the comms send and preview for every action whose entity maps to the held proposal
      (payment_reminder, invoice_send, portal_invite, the drink plan nudges, shopping_list_approve,
      consult_recap) and their legacy wrappers (send-reminder, portal-invite, the cc-import re-enroll), the
      balance due date PATCH, the shift routes (DELETE, PUT, cancel-or-unassign, assign, approve or deny,
      and the admin auto-assign) through the shift's proposal_id, the admin geocode backfill's bulk SELECT,
      and the two manual scripts (healBalanceReminderTimes.js, backfillExtrasInvoices.js). The refund route
      is not here: spec 2026-10-16 section 5.3 lets its reconciliation run for a held id, which the owner
      decides in legal-hold-client.
    footprint:
      - server/routes/proposals/cancel.js, lifecycle.js, crud.js (DELETE only), actions.js (send-reminder, balance-due-date)
      - server/routes/stripe.js  (payment-link only)
      - server/routes/invoices.js  (create and PATCH)
      - server/routes/comms.js  (requireAction)
      - server/routes/admin/ccImport/proposalActions.js
      - server/routes/shifts.js, shifts.handlers.js, shifts.approval.js
      - server/routes/admin/settings.js  (backfill-geocodes)
      - server/scripts/healBalanceReminderTimes.js, server/scripts/backfillExtrasInvoices.js
      - each route's existing test suite, plus a legal-hold case per route
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: [legal-hold-auto]
    lenses: tier A; the floor plus whatever the review skill computes; verify; the externals; the money smoke.
    laws: Money law 15; a refusal writes nothing, sends nothing and calls no provider; every other guard on these routes is unchanged and runs in its existing order after the legal-hold refusal.
    seams: the client shows the server's message for a 409 like any other refused write; the menu routes are lane menu-legal-hold-guards' (plan 2026-11-03), not this lane's.
    acceptance: Suites and the money smoke pass; each route's new case fails on main (on main the route writes, sends or calls Stripe for a synthetic held id).
    test plan: With a synthetic held id, each listed route answers 409 LEGAL_HOLD and changes no row, schedules and sends nothing; an unheld twin still succeeds; each script exits without writing for the held id.
    revert: revert the one squash commit; no data is written by the change.

  - id: legal-hold-client
    scope: >
      Waits on two owner decisions. First, money that arrives anyway: the client can still pay the held
      proposal's open invoice and drink plan through their token links, and the Stripe webhooks credit any
      payment that lands; either the pay pages refuse the held proposal up front, or they take the payment
      and the webhooks record it as today. Second, refunds: spec 2026-10-16 section 5.3 lets the refund
      route's reconciliation run for a held id; keep that, or refuse. Then: the token pay routes
      (create-intent-for-invoice, create-drink-plan-intent), the client change-request calculate and
      create routes (spec 5.3 already says they refuse a held id), the drink plan submit's extras paths,
      the webhook handlers, and the client view counter on the public proposal page.
    footprint: decided after the owner's answers.
    blockedBy: [legal-hold-admin]
    lenses: tier A.
    laws: Money law 15; captured money is never lost, whatever is decided.
    seams: decided after the owner's answers.
    acceptance: decided after the owner's answers.
    test plan: decided after the owner's answers.
    revert: revert the one squash commit.
---

# Legal-hold coverage

Money law 15 keeps the held proposal exactly as it is. The guard seam exists, but most of the system never calls it: a read-only audit of server/ on 2026-11-05 found about forty paths that can charge, chase, sweep, reconcile or write the held proposal, its shifts, its invoices or its messages. Some run on their own (the message dispatcher every five minutes, the balance-invoice monitor hourly); some are safe today only because of the held proposal's status or balance. This plan closes them in three lanes: the automatic jobs first, then the admin actions, then the client side and the webhooks once the owner decides how money that arrives anyway is handled.

No step here reads the held proposal's row: law 15 forbids an AI read of it, so every test uses synthetic held ids.
