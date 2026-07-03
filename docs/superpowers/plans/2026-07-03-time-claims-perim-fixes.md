---
lanes:
  - id: fix-time
    footprint:
      - server/utils/businessTime.js
      - server/utils/businessTime.test.js
      - server/utils/staffShiftHandlers.js
      - server/utils/balanceScheduler.js
      - server/utils/balanceScheduler.test.js
      - server/utils/balanceReminderScheduling.js
      - server/utils/balanceReminderScheduling.test.js
      - server/utils/payrollLateTip.js
      - server/utils/payrollLateTip.test.js
      - server/utils/payrollClawback.js
      - server/utils/payrollClawback.test.js
      - server/routes/admin/payroll.js
      - server/routes/admin/payroll.test.js
      - server/routes/proposals/actions.js
      - server/routes/proposals/recordPayment.statusGuard.test.js
      - server/scripts/healBalanceReminderTimes.js
    deps: []
    review: full-fleet + /second-opinion (money + scheduler paths)
  - id: fix-claims
    footprint:
      - server/db/schema.sql
      - server/utils/scheduledMessageDispatcher.js
      - server/utils/scheduledMessageDispatcher.claim.test.js
      - server/utils/emailSequenceScheduler.js
      - server/utils/emailSequenceScheduler.claim.test.js
      - server/utils/autoAssign.js
      - server/utils/autoAssign.claim.test.js
      - server/scripts/dedupeEmailSends.js
    deps: []
    review: full-fleet + /second-opinion (schema change + send paths are sensitive)
  - id: fix-perim
    footprint:
      - server/routes/thumbtack.js
      - server/routes/thumbtack.test.js
      - server/routes/thumbtackAgent.js
      - server/routes/thumbtackAgent.failures.test.js
      - server/routes/calcom.js
      - server/routes/calcom.test.js
      - server/routes/telegram.js
      - server/routes/telegram.test.js
      - server/routes/voice.js
      - server/routes/voice.test.js
      - server/routes/sms.js
      - server/utils/sms.js
      - server/utils/payrollDisputeNotify.js
      - server/utils/payrollDisputeNotify.test.js
    deps: []
    review: full-fleet (webhook/inbound + payroll-util paths are sensitive)
---

# Time / Claims / Perimeter fixes — plan v2 (2026-07-03)

REVISION of v1 after the /review-plan fleet (fidelity, decomposition, feasibility).
Material changes: review levels raised to full fleet on all three lanes (sensitive-path
rule); the Class-C migration list was WRONG in v1 (7 of 8 sites are formatters/validators
or UTC-internal math whose "migration" would have regressed them - incl. a Stripe autopay
idempotency key) and is now a classified keep-UTC list with ONE real migration; the
scheduled_messages status CHECK widening was missing; record-payment hardening moved from
fix-perim to fix-time (shared actions.js -> all three lanes now fully independent/parallel);
fractional-duration interval form kept; discriminating tests added for every changed site.

Source findings: `.claude/perimeter-time-sweep-2026-07-03.md`. Root cause: no canonical
business-time primitive. Verified preconditions: prod Postgres session tz = GMT;
proposals.event_timezone EXISTS (schema.sql:2358, TEXT NOT NULL DEFAULT 'America/Chicago',
all rows populated); staffShiftHandlers.eventLocalToUtc is pure with no external importers
(safe to move); all v1-cited line numbers verified exact.

## Lane fix-time

1. **`server/utils/businessTime.js`**: MOVE `eventLocalToUtc` here verbatim
   (staffShiftHandlers re-imports; internal caller computeEventStartUtc:141 + export
   list are the only touchpoints). ADD `chicagoTodayYmd()` (Intl/America/Chicago,
   DST-safe, server-tz-independent). No other primitives (v1's speculative
   `chicagoYmd(dateOrMs)` dropped - no consumer after reclassification).
   Tests: node:test on both functions incl. DST-transition dates.
2. **T1 auto-complete (HIGH)**: predicate at balanceScheduler.js:~181 becomes
   `((event_date + event_start_time::time + (event_duration_hours || ' hours')::interval)
   AT TIME ZONE event_timezone) < NOW()` - keep the interval-concat form
   (event_duration_hours is NUMERIC(4,1); make_interval(hours=>int) truncates 4.5h).
   Discriminating test under `SET timezone TO 'GMT'`: evening event that old predicate
   completes early and new predicate does not; plus a genuinely-ended event still
   completes.
3. **T2 due-today anchor**: balanceReminderScheduling SELECT (line ~24) ADDS
   event_timezone; each offset row anchors via `eventLocalToUtc(labelYmd, 9, 0, tz)`
   (9:00am local on the labeled day - the decided anchor; was implicit midnight-UTC =
   ~7pm the prior evening). Heal script `server/scripts/healBalanceReminderTimes.js`
   recomputes scheduled_for for PENDING rows only, prints per-type counts, sends nothing.
   Test: scheduled instants assert to 15:00Z (CDT) / 15:00Z-vs-16:00Z DST cases.
4. **T3/T4 pay-period pick**: payrollLateTip.js:86 + payrollClawback.js:109 use
   `chicagoTodayYmd()`. Discriminating test: mocked clock Mon 18:30 CST asserts the
   CURRENT Tue-Mon period is chosen (old code picks next week's).
5. **Class-C: ONE migration + a keep-UTC ledger.** Migrate ONLY admin/payroll.js:85
   (the `periods/current` today-pick) to `chicagoTodayYmd()`, with a discriminating
   evening-boundary test on the route. ALL other census sites are KEEP-UTC, recorded
   here deliberately: balanceScheduler:74 (formats balance_due_date INTO THE STRIPE
   AUTOPAY IDEMPOTENCY KEY - changing it risks re-charges; never touch),
   payrollPeriods:21 (toYmd(date) in a deliberately UTC-internal module; converting
   breaks Tue-Mon arithmetic), metricsQueries:19/:73 (UTC round-trip validator +
   range iso(); must stay UTC), paystubData:20 + admin/payroll:118 (pg DATE formatters;
   UTC slice correct), actions.js:70 (user-input validator round-trip), plus the
   seeds/QA/feeds/ccImport list from v1. The lane report restates this ledger.
6. **Record-payment status guard (moved from fix-perim)**: actions.js:170/:241
   blocklist `['balance_paid','confirmed']` gains 'completed','archived'.
   Discriminating test (`recordPayment.statusGuard.test.js`): manual payment on a
   completed proposal 409s and does NOT downgrade status.
7. NOT in scope (accepted, per findings doc): autopay/auto-assign CURRENT_DATE
   early-boundary, bookingWindow skew, DST noon-offset pair. Dead-file deletion
   (5 client files) is tracked in the findings doc, separate approval, not this plan.

## Lane fix-claims

0. **Schema first**: widen the scheduled_messages status CHECK to include
   'processing' (idempotent DROP CONSTRAINT IF EXISTS + ADD; reaches prod via initDb).
   Without this the claim UPDATE throws on first use (CHECK at schema.sql:2522/:3113).
1. **Dispatcher claim**: per-row `UPDATE ... SET status='processing' WHERE id=$1 AND
   status='pending' RETURNING id` before handling; terminal write gains
   `AND status='processing'`; failure path resets to 'pending' preserving the existing
   deferred/reactivation semantics; the existing stale-row guard (~:436, assumes
   'pending') is SUPERSEDED by the claim and updated accordingly. File is 903 lines -
   keep the delta lean; verify wc -l < 1000 post-change (else extract first).
2. **Sequences**: optimistic claim keyed on current_step before send; advance keeps
   the same predicate. Unique index on email_sends(lead_id, sequence_step_id) ships
   ONLY after a prod dupe-count returns ZERO (run the count first; if dupes exist,
   `server/scripts/dedupeEmailSends.js` heals them BEFORE the index lands - a failing
   CREATE UNIQUE INDEX in initDb would crash server boot). NULL sequence_step_id
   (campaign sends) stays unconstrained by design. NOT-VALID is not a thing for
   unique indexes; dedupe-first is the only path.
3. **Auto-assign**: `UPDATE shift_requests SET status='approved' ... AND
   status='pending' RETURNING id`; SMS only the RETURNED ids. The manual admin routes
   (shifts.approval.js upsert, crud.js, coverApprovalCascade) are EXPLICITLY out of
   scope: different semantics (admin-intent upsert), different files; noted here so
   the omission is deliberate, not missed.
Tests: per site, two pool connections racing the claim (gate-connection CONCEPT from
recordPayment.staleRead.test.js, re-implemented util-level, not its HTTP harness),
asserting exactly-one send/approval.

## Lane fix-perim (7 small guards, each with a fires-when-and-only-when test)

1. thumbtack.js duplicate-heal: on dedupe short-circuit, if the lead exists but draft/
   admin-notification artifacts are missing, run the post-commit steps. Test: simulate
   crash-after-commit (lead row present, no draft), retry heals; normal duplicate with
   artifacts present does NOT re-notify.
2. thumbtackAgent.js harvest-failed idempotency: identical (negotiation_id, reason)
   within a short window does not increment attempts. Test: double-POST bumps once.
3. calcom.js strand-heal: on 'Already processed', verify the consult exists; if
   missing, delete dedupe row + reprocess. Test: dedupe row present + no consult ->
   consult created; consult present -> untouched.
4. telegram.js: attachCallSid failure aborts cleanly (best-effort Twilio cancel +
   Zul notified) instead of a dead bridge. Test: failing write -> no dangling
   pending_call, cancel attempted.
5. voice.js status dedup by (CallSid, CallStatus). Test: redelivered 'failed' sends
   one Telegram message, one audit row.
6. PII last-4: routes/sms.js:90 Sentry extra + utils/sms.js:34/:24 adopt slice(-4).
   Test: log/extra payload assertions.
7. payrollDisputeNotify.js:125 -> urls.js ADMIN_URL. Test: unset CLIENT_URL still
   yields absolute admin URL.

## Order & protocol

All three lanes are independent (no footprint overlap; verified) - cut all three in
parallel. Prerequisite already satisfied: extract-hot (4183ede) + copy-client (dcedb4a)
merged before any fix lane cuts. Each lane: tests green serially -> full-fleet per-lane
review (+ /second-opinion where declared) -> squash-merge -> carve-out cleanup.
