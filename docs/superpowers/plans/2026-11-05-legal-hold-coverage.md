---
spec: none. The gap was found on 2026-11-05 by the money lens of the menu-bar-legacy-keys overlap pass (the balance charge has no legal-hold refusal) and widened by a read-only code audit of server/ the same night; money law 15 (docs/money-laws.md section 15) is the rule and spec 2026-10-16 section 5.3 the seam's design (server/utils/legalHold.js isLegalHold, the id list LEGAL_HOLD_PROPOSAL_IDS in server/utils/staleProposalSweep.js). The owner asked on 2026-11-05 for the lane to be built. This plan body records the design.
format: lane map without code (spec 2026-10-19 D12)
revision: 3 (2026-11-06; rev 2 folded in the design-stage plan review; rev 3 adds the paths the legal-hold-auto build found the audit had missed)
status: >
  Five lanes. legal-hold-auto, legal-hold-admin-money, legal-hold-admin-ops and legal-hold-client are
  built by Claude, one at a time in that order, each cut from current main in its own worktree,
  reviewed at the tier it computes (tier A), merged through scripts/merge-lane.sh from os. They share
  no file, so none waits on another. legal-hold-money-in is not cuttable: it waits on two owner
  decisions (below), and a plan revision fills its fields and runs /review-plan again first. Each lane
  ships on its own once merged: the menu bar work that once had to ship first was reverted from main
  by 7882775a (shipped 2026-11-05).
lanes:
  - id: legal-hold-auto
    scope: >
      Law 15 says the held proposal is never chased, swept or written, and the automatic jobs do not
      ask. Each job below leaves the held proposal out at the query that picks its rows, so it reads,
      writes and sends nothing for it, and the jobs over shifts, invoices or scheduled messages leave
      out the rows that belong to it. The ids come from one new helper beside isLegalHold,
      heldProposalIds(), read at call time; a missing list throws, so a job's run fails before any
      write (fails closed). The jobs: the scheduled-message dispatcher's pending SELECT, its
      deferred-reactivation UPDATE, its stranded-claim reap and the dead-letter resolver
      (server/utils/dispatcherDeadLetters.js), so a row tied to the held proposal directly or through
      its shift is never selected, flipped, reaped, dead-lettered, re-queued or sent; the
      balance-invoice monitor's two reconciliation SELECTs; the autopay claim and the event-completion
      UPDATE in balanceScheduler.js; the shift-closure sweep; the auto-assign scheduler's SELECT; and
      both service-extension sweeps. Balance reminder scheduling skips the held id silently at its
      entry, never throwing: it runs inside the Stripe webhooks (through depositPaidSchedulers.js and
      preEventScheduling.js), and a throw there would stop a landed payment from being recorded, which
      is legal-hold-money-in's decision; a missing list makes it schedule nothing and log once. The
      bulk exclusions sit here too: the admin geocode backfill's SELECT and the two manual scripts
      (healBalanceReminderTimes.js, backfillExtrasInvoices.js) leave the held proposal out and print
      the excluded count, and a write run refuses until a dry run has printed it (law 15: a bulk
      operation confirms the held row count first). The list stays in one place: staleProposalSweep.js
      checks it through isLegalHold instead of its own includes, and backfillFullPaymentInvoices.js
      reads heldProposalIds() instead of its own hard-coded set. Left out on purpose: the stale
      pending-refund sweep and the daily Stripe payout match, which record money Stripe has already
      moved (legal-hold-money-in); and the idempotent boot backfills in server/db/schema.sql, a known
      exception the owner sees here: each backfill's WHERE matches nothing after its first run, the
      held proposal's rows included, and a sensitive file replayed at every boot is not edited for a
      no-op.
    footprint:
      - server/utils/legalHold.js  (heldProposalIds(); fails closed)
      - server/utils/legalHold.test.js
      - server/utils/scheduledMessageDispatcher.js  (the pending SELECT, the deferred reactivation, the stranded-claim reap)
      - server/utils/dispatcherDeadLetters.js
      - server/utils/balanceInvoiceMonitor.js  (OVER_SQL and UNDER_SQL)
      - server/utils/balanceScheduler.js  (processAutopayCharges, processEventCompletions)
      - server/utils/shiftClosureSweep.js
      - server/utils/autoAssignScheduler.js
      - server/utils/serviceExtensionSweep.js  (sweepExpiredExtensions, healUnfinalizedExtensions)
      - server/utils/balanceReminderScheduling.js  (scheduleBalanceReminders' entry)
      - server/routes/admin/settings.js  (backfill-geocodes' SELECT only)
      - server/scripts/healBalanceReminderTimes.js, server/scripts/backfillExtrasInvoices.js, server/scripts/backfillFullPaymentInvoices.js
      - server/utils/staleProposalSweep.js  (its held check through isLegalHold and its two SELECTs through heldProposalIds(); the list itself unchanged)
      - server/utils/staleProposalSweep.test.js  (its poisoned-row case uses an out-of-range integer, since an unreadable id now reads as held)
      - server/utils/clientAutomationSuspension.js and its sibling-suppression path  (never flips or suppresses a row tied to the held proposal)
      - server/scripts/backfillShiftClosures.js  (leaves it out, prints the count, refuses a write run without it)
      - docs/money-laws.md  (law 15's Code line names heldProposalIds())
      - server/utils/legalHold.jobs.test.js  (new: every job and script above, one suite)
      - scripts/money-smoke-list.txt  (legalHold.jobs.test.js joins it, beside the other legal-hold suites)
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: []
    lenses: tier A; money (law 15), lifecycle, concurrency, outcomes-providers, access-egress, seams, schema-data (the scripts and the smoke list); verify; the externals; the money smoke.
    laws: Money law 15 exactly; the exclusion is added beside each job's existing WHERE, never in place of one; no job writes a row to mark a held item skipped; captured money is never lost (nothing here sits on a path that records a payment or a refund); a test adds only synthetic held ids through __setLegalHoldIdsForTest and never reads or writes the real held proposal.
    seams: one helper for every SQL exclusion and isLegalHold for every per-id check, so the list stays in one place; the dispatcher's archived suppression is unchanged; later lanes with a bulk exclusion (menu-no-menu-mark's backfill, plan 2026-11-03) use heldProposalIds().
    acceptance: >
      The reached suites and the money smoke pass, and legalHold.jobs.test.js fails on main for its
      stated reason under the review skill's failing-test procedure: on main each job selects, writes
      or sends for a synthetic held proposal, and each script includes it.
    test plan: >
      legalHold.jobs.test.js, with a synthetic held id and an unheld twin of each fixture: the
      dispatcher leaves the held proposal's pending, deferred, stranded and failed staff rows untouched
      and unsent and still processes the twin's; the monitor writes no activity row and sends no email
      for it; the autopay claim and the completion UPDATE skip it; the shift-closure, auto-assign and
      extension sweeps skip its rows; scheduleBalanceReminders schedules nothing for it and does not
      throw, also with the list missing; the geocode backfill leaves its shifts out; the four scripts leave it out, print
      the excluded count, and refuse a write run without the dry run's count; with the list missing each job
      throws before any write.
    revert: revert the one squash commit; no data is written by the change.

  - id: legal-hold-admin-money
    scope: >
      The admin money actions refuse the held proposal with 409 LEGAL_HOLD before they write, send or
      call Stripe, through the patchGuards.js assertNotLegalHold precedent: Charge balance
      (POST /api/stripe/charge-balance/:id, before its claim), the payment link
      (POST /api/stripe/payment-link/:id), cancel (POST /api/proposals/:id/cancel), the status change
      (PATCH /api/proposals/:id/status, forced or not), the proposal DELETE, invoice create
      (POST /api/invoices/proposal/:proposalId), invoice edit or void (PATCH /api/invoices/:id, through
      its proposal_id), the balance due date (PATCH /api/proposals/:id/balance-due-date) and send-reminder
      (POST /api/proposals/:id/send-reminder). The refund route is not here (legal-hold-money-in).
    footprint:
      - server/routes/stripe.js  (charge-balance and payment-link only)
      - server/routes/proposals/cancel.js, server/routes/proposals/lifecycle.js (status only), server/routes/proposals/crud.js (DELETE only), server/routes/proposals/actions.js (balance-due-date, send-reminder)
      - server/routes/invoices.js  (create and PATCH)
      - server/routes/legalHold.adminMoney.test.js  (new: every route above, one suite)
      - scripts/money-smoke-list.txt  (the new suite joins it)
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: []
    lenses: tier A; money (law 15), access-egress, outcomes-providers, lifecycle, concurrency, seams; verify; the externals; the money smoke.
    laws: Money law 15; a refusal writes nothing, sends nothing and calls no provider; every other guard on these routes is unchanged and runs after the legal-hold refusal.
    seams: the client shows the server's message for a 409 like any other refused write; the 409 body is the one the proposal PATCH already answers.
    acceptance: Suites and the money smoke pass; legalHold.adminMoney.test.js fails on main (on main each route writes, sends or calls a stubbed Stripe for a synthetic held id).
    test plan: legalHold.adminMoney.test.js, with a synthetic held id and Stripe stubbed: each route answers 409 LEGAL_HOLD, changes no row, schedules and sends nothing and calls Stripe zero times; an unheld twin still passes the guard.
    revert: revert the one squash commit; no data is written by the change.

  - id: legal-hold-admin-ops
    scope: >
      The admin actions that message the held proposal's client or move its shift refuse it with 409
      LEGAL_HOLD before they write or send: the comms send and preview, in requireAction, for every
      action whose entity maps to the held proposal (payment_reminder, invoice_send, portal_invite, the
      drink plan nudges, shopping_list_approve, consult_recap), and their legacy wrappers (portal-invite
      in lifecycle.js, the cc-import re-enroll); and the shift routes through the shift's proposal_id
      (DELETE, PUT, cancel-or-unassign, assign, approve or deny, and the admin auto-assign).
    footprint:
      - server/routes/comms.js  (requireAction)
      - server/routes/proposals/lifecycle.js  (portal-invite only)
      - server/routes/admin/ccImport/proposalActions.js
      - server/routes/shifts.js, server/routes/shifts.handlers.js, server/routes/shifts.approval.js
      - server/routes/legalHold.adminOps.test.js  (new: every route above, one suite)
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: []
    lenses: tier A if the review skill computes it; money (law 15), access-egress, outcomes-providers, seams, lifecycle, concurrency; verify; the externals.
    laws: Money law 15; a refusal writes nothing and sends nothing; every other guard is unchanged.
    seams: lifecycle.js is edited by legal-hold-admin-money too (the status route), so this lane is cut after that one merges, from current main.
    acceptance: Suites pass; legalHold.adminOps.test.js fails on main (on main each route sends or writes for a synthetic held id).
    test plan: legalHold.adminOps.test.js, with a synthetic held id and the senders stubbed: each comms action and wrapper answers 409 LEGAL_HOLD and sends nothing; each shift route answers 409 and changes no row; an unheld twin still passes.
    revert: revert the one squash commit; no data is written by the change.

  - id: legal-hold-client
    scope: >
      The client routes spec 2026-10-16 section 5.3 already decided: the change-request calculate and
      create refuse a held id (they price against the catalog, not the contract, and notify an admin);
      the drink plan submit's extras paths (the syrup pay-now invoice and the fold-skipped writes of
      num_bars, add-ons and invoices) refuse it before writing; and the public proposal page stops
      counting views for it. The spec put the change-request refusals in lane override-removal (plan
      2026-10-16), which never merged and is stale; this lane takes them, and override-removal re-cuts
      from its plan if it is ever revived.
    footprint:
      - server/routes/clientPortal/changeRequests.js
      - server/routes/drinkPlans/submit.js  (the extras paths only)
      - server/routes/proposals/publicToken.js  (the view counter only)
      - server/routes/legalHold.client.test.js  (new: every route above, one suite)
      - README.md, ARCHITECTURE.md  (generated sections)
    blockedBy: []
    lenses: tier A; money (law 15), access-egress, outcomes-providers, seams; verify; the externals; the money smoke.
    laws: Money law 15; a refusal writes nothing, sends nothing and reaches no provider; a client sees the same message any refused write gives.
    seams: the client portal and the drink plan pages show the server's message as they do for any refused write.
    acceptance: Suites and the money smoke pass; legalHold.client.test.js fails on main (on main each route writes for a synthetic held id).
    test plan: legalHold.client.test.js, with a synthetic held id: the change-request calculate and create answer the refusal and insert nothing; the drink plan submit creates no invoice and writes no proposal column; the public GET leaves view_count and last_viewed_at alone; an unheld twin still works.
    revert: revert the one squash commit; no data is written by the change.

  - id: legal-hold-money-in
    scope: >
      Not cuttable until the owner decides two questions and a plan revision fills this lane's fields.
      First, money that reaches Stripe anyway: the client can still pay the held proposal's open invoice
      and drink plan through their token links (create-intent-for-invoice, create-drink-plan-intent),
      the webhook handlers record any payment or refund that lands, and the daily payout match links
      payout lines to its payments; either the pay pages refuse it up front, or the payment is taken and
      recorded as today. Second, refunds: spec 2026-10-16 section 5.3 lets the refund route's
      reconciliation run for a held id, and the stale pending-refund sweep is the only thing that adopts
      a refund Stripe has already made; keep both, or refuse the refund route up front.
    footprint: filled by the plan revision after the owner's answers.
    blockedBy: [the owner's two decisions]
    lenses: tier A.
    laws: Money law 15; money Stripe has already moved is never lost or left unrecorded.
    seams: filled by the plan revision.
    acceptance: filled by the plan revision.
    test plan: filled by the plan revision.
    revert: revert the one squash commit.
---

# Legal-hold coverage

Money law 15 keeps the held proposal exactly as it is. The guard seam exists, but most of the system never calls it: a read-only audit of server/ on 2026-11-05 found about forty paths that can charge, chase, sweep, reconcile or write the held proposal, its shifts, its invoices or its messages. Some run on their own (the message dispatcher every five minutes, the balance-invoice monitor hourly); some are safe today only because of the held proposal's status or balance. This plan closes them in five lanes: the automatic jobs and bulk exclusions, the admin money actions, the admin messaging and shift actions, the client routes the earlier spec already decided, and, once the owner decides, the money that reaches Stripe anyway.

The AI reads of booking data are the Inbox (server/utils/inbox/, already guarded) and the menu designer (lane menu-legal-hold-guards, plan 2026-11-03); no other server path calls an AI wrapper.

No step here reads the held proposal's row: law 15 forbids an AI read of it, so every test uses synthetic held ids.

Three older lane branches touch these files: override-removal (crud.js, the change-request routes), gv-post-server (comms.js) and rewrite-step5-lint-errors (crud.js, shift and balanceScheduler tests). All three are stale; whichever lane merges second re-cuts from its plan.
