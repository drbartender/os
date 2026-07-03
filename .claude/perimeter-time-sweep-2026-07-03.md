# Perimeter + Time Sweep — 2026-07-03

Second third-party burn: codex (integration perimeter, schedulers/time) + gemini pro
(template-data integrity, x2 chunks) + mechanical dead-code scan. Every finding verified
(5 Claude agents + 2 inline passes). Key verified deployment facts: **prod Postgres session
tz = GMT** (live SHOW timezone); Render Node = UTC default; single instance with
RUN_SCHEDULERS gating; initial-tick staggers (60/90/180s) currently outlast Render's ~30s
deploy drain.

**STATUS: ALL THREE FIX BATCHES BUILT, REVIEWED, MERGED 2026-07-04 early AM (unpushed):
fix-time f7d8b47, fix-claims 99fd240, fix-perim 7b01a78** (plan v2 executed; per-lane
full-mandate fleets + codex + gemini; repair rounds folded in: Chicago-basis due-date
guard, 10am anchor unification with the reschedule reanchor path, stranded-claim reaper
(claimed_at + tick sweep), 'processing' propagated to enqueue guards + dedupe index,
atomic harvest dedupe+increment, alert-before-audit ordering, calcom heal startTime gate,
alerting-reason dedupe. Accepted residuals recorded in the plan/lane reports: DST-spanning
event completion (2 days/yr class), multi-instance sibling suppression, auto-assign
capacity semantics (pre-existing), sequence eligibility window (pre-existing), calcom
CANCELLED-strand scoping, thumbtack persistent-draft-failure re-notify. Client-side
canRecordPayment archived-gate = UX follow-up.**

Original pre-fix status: 23 findings adjudicated: 20 confirmed
(1 HIGH, 3 MED, 16 LOW), 3 rejected. Severities below are post-verification.

## HIGH

- **T1. Auto-complete fires 5-6h early on every fully-paid event.**
  `balanceScheduler.js:196` — naive wall-clock `event_date + event_start_time + duration`
  compared to `NOW()` in a GMT session reads Chicago wall-clock as GMT. A 6pm-9pm event
  "completes" at ~4pm Chicago — BEFORE it starts: payroll accrual, review request
  scheduling, retention emails, change-request reaping all fire mid-event or pre-event.
  Latent since 2026-05-15 (36a08a2); clients have likely received post-event content early.
  Fix pattern already in-repo: staffShiftHandlers' event_timezone-aware helper.

## MED

- **T2. "Balance due today" email+SMS send ~6-7pm Chicago the evening BEFORE the due date.**
  `balanceReminderScheduling.js:35` — DATE parsed at Node-local midnight (UTC on Render)
  becomes scheduled_for = 00:00Z. Both messages are cooldownExempt so they fire immediately.
  Contingent on Render TZ=UTC (default; vanishes if TZ=America/Chicago were ever set).
- **T3/T4. Monday-evening late tips AND clawbacks land in next week's pay period.**
  `payrollLateTip.js:86` + `payrollClawback.js:109` — `new Date().toISOString().slice(0,10)`
  is the UTC date; Chicago >= 6-7pm resolves to tomorrow. On Monday period-boundary evenings
  (events end late Monday!) the Tue-Mon grid rolls the tip/clawback into the NEXT period,
  delaying staff money a full cycle. Server-tz-independent (toISOString is always UTC);
  fix = Chicago-offset-adjusted today (or the payrollAccrual toCalendarYmd pattern).

## LOW — confirmed, grouped

- **Send-claim gaps (latent-HIGH on scale-out or long deploy drains):** dispatcher
  (`scheduledMessageDispatcher.js:624` — no atomic claim, terminal UPDATE lacks
  `AND status='pending'`), drip sequences (`emailSequenceScheduler.js:25` — no claim, no
  unique send guard, no single-flight; self-overlap needs ~750 due sends), auto-assign
  (`autoAssign.js:330` — no `AND status='pending'` claim; manual route can race the hourly
  sweep -> duplicate approval SMS). Today's protection is the tick staggers vs Render's
  drain window, i.e. timing luck. Fix = one claim predicate each (+ SKIP LOCKED batch).
- **Perimeter resilience quartet:** thumbtack lead commits before draft+admin notify
  (crash+retry loses both, silently — watch-first; Thumbtack app still notifies),
  harvest-failed has no idempotency key (retries burn the 3-attempt cap; alert fires +
  /rearm recovers), calcom dedupe row commits pre-handler (hard-kill strands the consult
  mirror; booking survives in Cal.com), telegram attachCallSid best-effort but /bridge
  requires it (transient DB blip = one dropped call, self-heals on resend).
- **Perimeter hygiene:** voice status callbacks lack CallSid+status dedup (dup Telegram
  nudge + audit row; spend cap unaffected); pending-harvest lease is deliberate
  at-most-once (6h cooldown re-offer; by design); Sentry `extra` carries full From number
  (`routes/sms.js:90` — beforeSend scrubs everything EXCEPT extra); sendSMS logs full
  recipient (`utils/sms.js:34`, body too on gated path :24) — both outliers vs the
  codebase's last-4 discipline.
- **Timing quirks, accepted:** autopay charges ~6-7pm the evening before the due date
  (`balanceScheduler.js:40` — correct amount, perception only); auto-assign eligibility
  opens 5-6h early (`autoAssignScheduler.js:21`); bookingWindow lead-time 5-6h short
  (`bookingWindow.js:29` — documented in-file as accepted imprecision; flips
  fullPaymentRequired/last-minute-hold slightly early = strict direction);
  DST noon-offset pair (`eventEveSms.js:66`, `staffShiftHandlers.js:110`) — 1h error ONLY
  for events/shifts starting 12:00-1:59am on a transition day (2 days/yr; the claimed
  23h/25h magnitude was refuted).
- **payrollDisputeNotify.js:125** uses `CLIENT_URL || ''` instead of urls.js ADMIN_URL
  fallback (broken admin link only if env unset; one-liner).

## Rejected

- gemini's 3 template date-shift HIGHs (ccWrapUp, marketing x2): no timeZone option is
  passed, so parse-tz == format-tz on every data path; correct day renders on UTC prod.
  Latent style hazard only if server tz ever changes. Also gemini's repeat `join('n')`
  hallucination + phantom mailto-space (chunk B, 0/3).

## Dead code (sweep 6, verified)

Server: ZERO orphan files. Client: 5 dead files, ~578 lines, verified unreferenced incl.
dynamic imports — `LocationInput.js` (superseded by venue search), `adminos/Sparkline.js`,
`staff/Placeholder.js`, `pages/website/Website.js` (superseded by QuoteWizard refactor),
`plan/data/cocktailMenu.js` (comment-referenced only). Deletion awaiting per-action yes.
CheckCherry: zero user-visible mentions (comments/ccImport tooling only).

## Proposed fix batches

- **Batch TIME (the one that matters): T1 + T2 + T3/T4.** One lane; adopt the
  event_timezone/Chicago-aware pattern at the four sites. T1 is the headline.
- **Batch CLAIMS: the three send-claim predicates** (+ optional SKIP LOCKED). Cheap
  insurance against scale-out/slow-drain; removes the timing-luck dependency.
- **Batch PERIM (small guards):** thumbtack post-commit heal (re-run draft+notify on
  duplicate if missing), harvest-failed idempotency key, calcom strand heal (verify
  consult exists on 'Already processed'), attachCallSid hard-fail (abort call cleanly),
  voice callback dedup, last-4 both PII sites, ADMIN_URL fallback.
- **Not fixing (accepted):** autopay/auto-assign early-eligibility, bookingWindow skew,
  DST noon-offset pair (revisit if a midnight event ever books).
