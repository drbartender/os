---
lanes:
  - id: fix-time
    footprint:
      - server/utils/businessTime.js
      - server/utils/staffShiftHandlers.js
      - server/utils/balanceScheduler.js
      - server/utils/balanceReminderScheduling.js
      - server/utils/payrollLateTip.js
      - server/utils/payrollClawback.js
      - server/utils/payrollPeriods.js
      - server/utils/paystubData.js
      - server/utils/metricsQueries.js
      - server/routes/admin/payroll.js
      - server/routes/proposals/actions.js
      - server/scripts/healBalanceReminderTimes.js
      - "**/*.test.js"
    deps: []
    review: full-fleet + /second-opinion (money + scheduler paths)
  - id: fix-claims
    footprint:
      - server/utils/scheduledMessageDispatcher.js
      - server/utils/emailSequenceScheduler.js
      - server/utils/autoAssign.js
      - server/db/schema.sql
      - "**/*.test.js"
    deps: []
    review: fleet-lite (money-correctness + database)
  - id: fix-perim
    footprint:
      - server/routes/thumbtack.js
      - server/routes/thumbtackAgent.js
      - server/routes/calcom.js
      - server/routes/telegram.js
      - server/routes/voice.js
      - server/routes/sms.js
      - server/utils/sms.js
      - server/utils/payrollDisputeNotify.js
      - server/routes/proposals/actions.js
      - "**/*.test.js"
    deps: [fix-time]   # actions.js overlap only; serialize AFTER fix-time merges (one-line status-blocklist item)
    review: fleet-lite (security + consistency)
---

# Time / Claims / Perimeter fixes — plan (2026-07-03)

Source findings: `.claude/perimeter-time-sweep-2026-07-03.md` (all verified). Root-cause
framing per systematic-debugging: the time bugs are ONE root cause — no canonical
business-time primitive; 26 `toISOString().slice(0,10)` sites, 13 naive-SQL-time files,
37 `CURRENT_DATE` uses all improvise. Working references already in-repo:
`staffShiftHandlers.eventLocalToUtc` (DST-honoring, event_timezone-aware) and
`stripePayoutSync:184` (atomic claim, "never check-then-act").

## Lane fix-time (the HIGH + the class)

1. **New `server/utils/businessTime.js`** (small, pure): `eventLocalToUtc` MOVES here
   (staffShiftHandlers re-imports; pure move), plus `chicagoTodayYmd()` and
   `chicagoYmd(dateOrMs)` built on Intl/America/Chicago (DST-safe, server-tz-independent).
2. **T1 auto-complete (HIGH), SQL-side fix:** the completion predicate becomes
   `(event_date + event_start_time::time + make_interval(hours => event_duration_hours))
   AT TIME ZONE COALESCE(event_timezone, 'America/Chicago') < NOW()` — naive wall-clock
   interpreted in the event's zone, yielding timestamptz for a correct comparison in any
   session tz. Test MUST assert under an explicit GMT session (SET timezone) with an
   evening event that old code completes early and new code does not (discriminating).
   VERIFY FIRST in the lane: proposals.event_timezone column exists + its default
   (staffShiftHandlers already consumes it); if absent, COALESCE against the constant.
3. **T2 due-today timing:** `balanceReminderScheduling` anchors each offset row to an
   explicit Chicago-local send time via `eventLocalToUtc(dueYmd, 9, 0, tz)` (9:00am
   Chicago on the labeled day; t-3/t+1/t+3 same pattern). PLUS one-off heal script
   `healBalanceReminderTimes.js` for PENDING rows only (recompute scheduled_for; report
   count; no sends). Decision point recorded: 9am Chicago is the chosen anchor (was:
   implicit midnight-UTC).
4. **T3/T4 pay-period pick:** `payrollLateTip.js:86` + `payrollClawback.js:109` use
   `chicagoTodayYmd()`. Regression test: freeze clock at Mon 18:30 CST (mock Date) and
   assert the CURRENT Tue-Mon period is chosen, not next week's.
5. **Class-C migration (classified, not blanket):** migrate the materially-wrong sites to
   `chicagoTodayYmd()`: `admin/payroll.js:85/:118` (current-period routes),
   `paystubData.js:20`, `balanceScheduler.js:74`, `payrollPeriods.js:21` (default arg),
   `metricsQueries.js:19/:73` (dashboard ranges), `proposals/actions.js:70`. Each site
   gets a one-line classification note in the lane report. Sites intentionally LEFT UTC
   (seeds, QA, external-feed timestamps, shifts.js display, calendar feeds, ccImport,
   rescheduleProposal internals) are listed with reasons — no silent skips.
6. **Class-A audit note:** the 13 naive-SQL files are classified in the lane report
   (bug/coarse/display); only T1 is changed in this lane. Any second material find =
   its own follow-up, not scope creep here.
7. NOT in scope (accepted, doc'd): autopay/auto-assign CURRENT_DATE early-boundary,
   bookingWindow skew, DST noon-offset pair.

## Lane fix-claims (timing-luck removal)

Copy the stripePayoutSync atomic-claim shape at three sites:
1. Dispatcher: per-row claim `UPDATE scheduled_messages SET status='processing' WHERE
   id=$1 AND status='pending' RETURNING id` before handling; terminal write gains
   `AND status='processing'`; failure path resets to 'pending' (respecting existing
   retry semantics — read them first).
2. Sequences: optimistic claim keyed on current_step (`UPDATE ... SET last_...=NOW()
   WHERE id=$1 AND current_step=$2 RETURNING`) before send; advance keeps the same
   predicate. PLUS idempotent unique index on email_sends(lead_id, sequence_step_id)
   in schema.sql (belt; prod gets it via initDb) — verify no existing dupes first
   (SELECT count on prod BEFORE the index ships; if dupes exist, index is created
   after a dedupe heal or as NOT VALID — decide in-lane on evidence).
3. Auto-assign: `UPDATE shift_requests SET status='approved' ... AND status='pending'
   RETURNING id`; SMS only the RETURNED ids. Manual-route race gets the same predicate.
Tests: each site gets a two-concurrent-claims test (gate-connection pattern from
recordPayment.staleRead.test.js) asserting exactly-one send/approval.

## Lane fix-perim (small guards; runs after fix-time merges — actions.js overlap)

1. thumbtack.js: on duplicate short-circuit, heal-check — if lead exists but draft/admin
   notification missing, run the post-commit steps then (mirrors F1b settle-after-
   side-effect heal pattern from smsInbound).
2. thumbtackAgent.js harvest-failed: idempotency key (negotiation_id + reason + agent
   attempt nonce; simplest: skip increment if an identical failure was recorded within
   N minutes — decide in-lane from the agent's actual retry cadence).
3. calcom.js: on 'Already processed', verify the consult row exists; if missing, delete
   the dedupe row and reprocess (bounded heal, no behavior change on the happy path).
4. telegram.js: attachCallSid failure aborts cleanly (cancel the Twilio call best-effort
   + tell Zul to retry) instead of letting /bridge hang up on an answered call.
5. voice.js status callback: dedupe by (CallSid, CallStatus) — skip Telegram+audit when
   an identical audit row exists.
6. PII last-4: routes/sms.js:90 Sentry extra + utils/sms.js:34/:24 logs adopt the
   existing slice(-4) discipline.
7. payrollDisputeNotify.js:125 -> urls.js ADMIN_URL.
8. record-payment status-downgrade hardening (push-review follow-up): add
   completed/archived to the already-paid blocklist in proposals/actions.js:170/:241.

## Order & merge protocol

fix-time and fix-claims cut immediately, in parallel. fix-perim cuts after fix-time
merges (shared actions.js). Each lane: tests green serially -> per-lane review at its
declared level -> squash-merge -> carve-out cleanup. The three ALREADY-BUILT lanes
(extract-hot, copy-client) merge FIRST, before fix-time cuts, so the time lane builds
on the extracted stripeWebhook/invoiceHelpers shape and no fix lands in a file about
to be restructured.
