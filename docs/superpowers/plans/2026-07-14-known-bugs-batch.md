---
spec: docs/superpowers/specs/2026-07-14-known-bugs-batch-design.md
findings: docs/superpowers/specs/2026-07-14-known-bugs-batch-findings.md
lanes:
  - id: kb-a-cancel-archive
    bugs: [B1, B2, B5, B3-piece3, B14-cancel-site]
    footprint:
      - server/utils/shiftReap.js
      - server/routes/proposals/cancel.js
      - server/routes/proposals/actions.js
      - server/routes/proposals/archive.test.js
      - server/routes/proposals/cancel.test.js
      - client/src/pages/admin/ProposalDetail.js
      - client/src/pages/admin/ProposalDetailPaymentPanel.js
      - client/src/components/adminos/shifts.js
      - server/routes/proposals/list.js
    deps: []
    review: full-fleet
    sensitive: true   # by plan mandate (m1-refund-reap), not by path list
  - id: kb-b-money-doors
    bugs: [B3-piece1, B3-piece2]
    footprint:
      - server/routes/stripe.js
      - server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js
      - server/routes/stripeWebhookHandlers/checkoutSessionCompleted.js
      - server/routes/stripe.invoiceIntentArchived.test.js
      - server/routes/stripeWebhook.archivedSettle.test.js
    deps: []
    review: full-fleet
    sensitive: true
  - id: kb-c-held-upserts
    bugs: [B4]
    footprint:
      - server/utils/payrollClawback.js
      - server/utils/payrollLateTip.js
      - server/utils/payrollClawback.test.js
      - server/utils/payrollLateTip.test.js
    deps: []
    review: full-fleet
    sensitive: true
  - id: kb-d-negadj-hold
    bugs: [B13]
    footprint:
      - server/utils/payrollAccrual.js
      - server/utils/paystubData.js
      - server/routes/staffPortal/payouts.js
      - client/src/pages/admin/payroll/EventLineItem.js
      - server/utils/payrollAccrual.sweepPreserve.test.js
    deps: []
    review: full-fleet
    sensitive: true
  - id: kb-e-refund-sweeper
    bugs: [B6]
    footprint:
      - server/utils/refundExecute.js
      - server/utils/refundSweepScheduler.js
      - server/utils/refundExecute.test.js
      - server/utils/refundSweepScheduler.test.js
      - server/index.js
      - .env.example
      - .claude/CLAUDE.md
      - README.md
    deps: []
    review: full-fleet
    sensitive: true
  - id: kb-f-notify-dedup
    bugs: [B9, B10, B11]
    footprint:
      - server/utils/eventEveSms.js
      - server/utils/eventEveSms.test.js
      - server/routes/thumbtack.js
      - server/routes/thumbtack.test.js
      - server/routes/voice.js
      - server/routes/voice.test.js
      - server/utils/pendingCall.js
      - server/db/schema.sql
      - server/db/schema.vaCalling.test.js
    deps: []
    review: full-fleet
    sensitive: true
  - id: kb-g-trim-align
    bugs: [B14-remaining-sites]
    footprint:
      - server/utils/autoAssign.js
      - server/utils/coverBroadcast.js
    deps: []
    review: full-fleet
    sensitive: true
  - id: kb-h-small
    bugs: [B7, B8, B12]
    footprint:
      - client/src/pages/admin/CancelEventDialog.js
      - client/src/pages/admin/CancelEventDialog.test.js
      - server/routes/stripeWebhookHandlers/checkoutSessionCompleted.lastMinute.test.js
      - docs/audit-2026-07-13/migration-plan.yaml
      - scripts/sensitive-paths.txt
    deps: []
    review: light
    sensitive: false
---

# Known-Bugs Batch: Lane Plan (2026-07-14)

Eight file-disjoint lanes, all parallel. Every builder reads the spec plus its
bug sections in the findings doc BEFORE coding; the findings doc carries current
file:line anchors, red-test designs, and hard constraints per bug. TDD in every
lane: write the red test first, watch it fail, then fix.

## Build notes per lane

- **kb-a-cancel-archive** (largest; internal order matters): (1) extract
  shiftReap.js from cancel.js verbatim WITH the B14 TRIM fix applied in the
  extracted SQL, run cancel.test.js green; (2) B3 piece 3 (surviving-invoice
  PI-cancel at cancel time, red test in cancel.test.js); (3) archive endpoint
  reap + B2 reason plumbing + archive.test.js red tests; (4) B5 snapshot cap +
  cancel.test.js red tests (mid-loop-failure rig, second-run zero, B3-headroom
  green guard); (5) client prompt + reason select + chip rider, then
  `CI=true npx react-scripts build` in client/. cancel.test.js is edited by
  this lane ONLY.
- **kb-b-money-doors**: route guard first (409 EVENT_CANCELLED), then the two
  webhook alert hooks. The credit paths must stay byte-identical; the in-tx
  activity-log insert uses the handler's existing dbClient; Sentry +
  notifyAdminCategory post-commit only. New test files use the local-HMAC
  webhook harness (stripeWebhook.guards.test.js pattern) and the stripeClient
  stub seam (stripe.chargeBalanceDurable.test.js pattern).
- **kb-c-held-upserts**: the two CASE edits exactly as designed; ELSE branches
  byte-identical (H1 pins at payrollClawback.test.js:239 and
  payrollLateTip.test.js:486 must stay green untouched).
- **kb-d-negadj-hold**: no schema.sql edit (the planned comment update is
  dropped to keep the footprint disjoint from kb-f; the hold-semantics comment
  in payrollAccrual.js carries it). The paystub/portal sign-scoping ships in the
  SAME commit as the sweep change or stubs stop footing.
- **kb-e-refund-sweeper**: scheduler follows the stripe_payout_sweep
  registration block byte-for-byte (enabled gate, wrapScheduler, stagger,
  clearHealthRow else-branch). Env var documented in .env.example + CLAUDE.md +
  README tables (mandatory-docs rule).
- **kb-f-notify-dedup**: three independent fixes, one reviewed pass (the sweep
  memory's recorded shape). B11 schema index is additive + idempotent. The
  B10 heal-test backdate edit is semantics-preserving; call it out to reviewers.
- **kb-g-trim-align**: two predicate edits + optional focused tests. Tiny diff,
  but coverBroadcast.js is sensitive-listed so the fleet runs.
- **kb-h-small**: B7 dialog + new RTL test (client build gate applies), B8
  test-only fix, B12 doc stamps + sensitive-paths.txt addition.

## Gates

1. **B11 prod pre-check (BLOCKS kb-f merge):** read-only against prod Neon:
   `SELECT call_sid, status, COUNT(*) FROM call_audit WHERE call_sid IS NOT NULL
   AND status IN ('no-answer','busy','failed','canceled') GROUP BY 1,2 HAVING
   COUNT(*) > 1`. Any rows: dedupe offenders (keep oldest) before the index can
   ship, or boot-time CREATE UNIQUE INDEX fails the deploy.
2. Per-lane review before merge, scaled per front-matter. The iron rule applies:
   a non-completing or verdict-less agent is a blocker, re-dispatch once.
3. Merges serialized through merge-lane.sh; kb-a merges first (largest surface),
   then any order. Another window is building lane natabs-a: check
   `git status`/`git worktree list` for its state before each merge; conflicts
   on sensitive paths stop and escalate.
4. Post-merge on main: each lane's suites re-run serially, then
   `CI=true npx react-scripts build` once (client-touching lanes: a, d, h).
5. Push is NOT part of this plan (explicit Dallas cue only). At push time this
   batch triggers the full fleet + /second-opinion on the sensitive commits per
   CLAUDE.md, plus the money smoke gate.

## Dev-DB coordination

Suites here write to the shared dev DB (payroll suites use the Chicago
track-and-restore fixtures; cancel/archive suites use NONCE fixtures with
cleanup). Run one suite at a time per lane; across parallel lanes accept the
flake risk and re-run serially on failure before diagnosing (t4 isolation
covers the payroll suites; the other window may also be testing).
