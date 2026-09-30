# Consult Call Bridge Hardening (fix list section 0)

Design, 2026-09-30, **rev 2**. Brainstormed section by section with Dallas; all four sections were approved in chat. Rev 2 folds in the six-lens design fleet (spec grounding / gaps / risk, plan fidelity / decomposition / feasibility), every finding verified against the code before it was accepted, and Dallas approved the fold-in as a batch. Rev 2 changes, in one place: the kill switch parks rings 1 and 2 (6.1), a same-uid reschedule to a new time is not a replay and a root uid resolves through the prior list (5.2), the one-stop email is bounded per booker per day and its banner covers other slots (4.1), `/dialend` answers Twilio first (4.2), the Zul leg's `call_audit` row carries no number (6.3), Needs attention gets the unconfirmed label and every "never reaped" statement is corrected (4.3), two lanes (7a). This document is the contract for the plan and the build. It closes section 0 of `docs/fix-list-remaining-2026-07-02.md` ("The consult call bridge is LIVE, and these are reachable right now") plus the section 3 entry "Pressing 1 during the automatic repeat does nothing, on BOTH bridges".

Parent design: `docs/superpowers/specs/2026-08-25-consult-call-bridge-design.md` (rev 2). Every locked decision there still holds unless this document names it.

## 1. Why

The consult bridge merged as `fafa0d6f`, shipped 2026-08-25, and is ARMED in production. Its declared failure mode is silence: a consult nobody rings is a client waiting for a call that never comes. Section 0 of the ledger lists the ways the shipped code can still go quiet, or can duplicate a consult and silence the real one.

Prod facts at design time (read-only, 2026-09-30): 4 attempt rows ever (2 `connected`, 2 `missed`), zero `skipped_cancelled` rows, zero `rescheduled_unresolved` rows, zero upcoming consults, 3 consults booked in the last 30 days, last chain 2026-09-18. Both `connected` rows carry a `bridge_duration_sec` (82 and 378), so the new unconfirmed-bridge check in 4.3 flips nothing on its first run. Prod has never processed a Cal.com reschedule, so the new column in section 5 needs no backfill.

Reachable and unfixed, therefore, but not yet bitten. Volume is low enough that every alert added here costs almost nothing in noise.

## 2. Goal and success

No consult bridge failure is silent, and no repeated Cal.com delivery can duplicate a consult or silence a real one. Done means each case below either emails Dallas exactly once or cannot happen, and a test that fails on today's code pins each one.

## 3. Scope decisions

- **In:** every section 0 entry except the status rename, plus the press-1-during-the-repeat fix on BOTH bridges (the lead bridge carries the same TwiML).
- **Out, decided against: giving the sibling stop its own status.** `skipped_cancelled` / `rescheduled_unresolved` is one status carrying two meanings, and the ledger asked for a status of its own. That was only dangerous because the one-row stop was quiet. Once 4.1 makes it email, a rename changes no behavior while touching the schema CHECK (two sites), the `constraintContract` manifest in `server/db/index.js`, the chain INSERT, `client/src/utils/consultCallLabel.js`, and the attention feed. It gets a Settled line in the ledger, and the code comments that still say the write side "owes" a status are reworded (section 7).

## 4. Nothing stays silent

### 4.1 A single stopped sibling emails

`consultCallTail` (`server/utils/consultCallChain.js`), the unresolved-reschedule branch: the email gate `marked.rowCount > 1` becomes "at least one row stopped, and no earlier stop for this booker email today (Chicago calendar day)". Still ONE email per tail call (never one per row). The attempt passed to `sendChainEmail` is still `marked.rows[0]`, a stopped sibling, so the email names a slot that will NOT ring.

**The per-day bound per booker email (review 2026-09-30).** The Cal.com webhook limiter allows 600 deliveries a minute, and every unresolved reschedule that stops a row would otherwise cost one email against the shared 100/day Resend allowance that proposals and invoices also use. The parent spec bounded the undialable email for the same reason. The bound rides the sibling INSERT itself as a data-modifying CTE: the outer SELECT returns the inserted ids plus `stopped_today`, whether any `skipped_cancelled / rescheduled_unresolved` row for the same `booker_email` already exists since Chicago midnight (the CTE's own inserts are invisible to it, same snapshot). A calendar day, not the rolling 24 hours first specified: the per-lane database review showed that each new stop would re-open a rolling window, so one dummy booking a day could keep a victim's later stops silent forever. The status filter lets the lookup use the existing `(status, created_at)` index. Known residual (per-lane security review): a reschedule back onto the same slot runs the R16 clear, which deletes the stop row the bound counts, so a determined booker can buy an extra email; worth nothing beyond using a fresh email. Two concurrent deliveries can both see none and send two emails; duplicate mail is the right way for this feature to be wrong. One email per victim per day is enough to send Dallas to that booker's slots.

The comment above the gate is rewritten to say why one row now emails: the one-row case is exactly "the victim had one real consult", and the email cannot tell that apart from the booker moving their own slot, so it goes to a human either way.

The `unresolved reschedule` banner (`CONSULT_CALL_BANNERS`, `server/utils/emailTemplates.js`) is reworded to fit one row or many:

> Someone rescheduled using this booker's email and we could not tell which booking moved, so the call for this slot, and for any other upcoming slot under this email, was stopped and will not ring. If this is the slot they moved away from, there is nothing to do. If not, call them at the slot.

`ARCHITECTURE.md`'s consult Alerts line (it says a single stopped sibling "stays a log line") is corrected with it.

The template's comment that says the banner is "only sent when more than one row was stopped" is corrected.

### 4.2 A failed client-no-answer text becomes the email

Today `/dialend` (`server/routes/voiceConsultCall.js`) calls `sendMissedText({ kind: 'client_no_answer' })` and discards the result. Its sibling `finishMissed` turns an unsent text into the one admin email.

New export in `consultCallChain.js`: `notifyClientNoAnswer({ attemptId })`. It sends the `client_no_answer` text; when the discriminated result is anything but `'sent'` it sends the one chain email with a reason from its own Map (same Map-not-object-literal rule as `MISSED_TEXT_EMAIL_REASON`):

| `sendMissedText` result | email reason |
|---|---|
| `no_destination` | `client no answer, no text destination` |
| `send_failed` | `client no answer, text failed` |
| `no_attempt` | `client no answer, text failed` |

It never throws. `/dialend` calls it in place of `sendMissedText`, still only for the latch winner (text-exactly-once law unchanged), and now AFTER it has answered Twilio with the spoken readback (review 2026-09-30): the failure case is exactly when Twilio's SMS API is slow, a text plus a fallback email can outlast Twilio's 15-second webhook timeout, and a late answer would lose the "Their number is..." readback for whoever is on the line. The route's test seam swaps accordingly.

Two new banners:

- `client no answer, no text destination`: "The client did not pick up when the bridge called them, and no text destination is configured, so this email is the only alert. Call them back."
- `client no answer, text failed`: "The client did not pick up when the bridge called them, and the text alert could not be sent, most likely a Twilio failure rather than a setting. Call them back."

### 4.3 A press-1 that never reaches the client is reported

`connected` is terminal and was never reaped, so a `<Dial>` that fails at Twilio without producing either callback leaves a settled-looking row and no alert. The client leg can report back two ways: its `<Number statusCallback>` writes `bridge_duration_sec`, and the `<Dial action>` (`/dialend`) latches `client_no_answer_at` for no-answer, busy, failed or canceled. A row with neither, long after the bridge could possibly still be running, has no evidence the client was ever called.

The stale-chain reaper gains a second arm:

```sql
UPDATE consult_call_attempts
   SET status = 'failed', detail = 'bridge_unconfirmed', updated_at = NOW()
 WHERE status = 'connected'
   AND bridge_duration_sec IS NULL
   AND client_no_answer_at IS NULL
   AND bridge_started_at < NOW() - make_interval(secs => $1::int)
RETURNING id
```

`$1` is the call time limit plus ten minutes (`VA_CALL_TIME_LIMIT_SEC`, default 1800, plus 600). One email per row it flips, reason `bridge unconfirmed`:

> Someone pressed 1 on this consult, but Twilio never reported the call to the client, so it most likely never connected. Call them to check.

Status `failed` puts it in Needs attention (`server/routes/admin/leadCalls.js` already lists `failed` for consults) until the consult leaves `scheduled`. If Twilio merely lost the report of a real call, the cost is one false alarm, which is the correct way for this feature to be wrong.

**Kill switch off: this arm does not run at all.** No write, no email, matching the reaper's existing rule that the switch silences the alert. A row left `connected` then is picked up on the first tick after the switch comes back on.

`client/src/utils/consultCallLabel.js` gains a detail branch so the proposal and client detail pages read `pressed 1, bridge unconfirmed` for this row rather than the generic failed label, and the Needs attention headline (`client/src/pages/admin/overview/queueItems.js`, which reads every consult `failed` as "call failed") gains the same branch, since that feed is where the row actually surfaces.

The detail overwrites whatever `detail` held, deliberately: both labels key on `bridge_unconfirmed`, and a Twilio code from an earlier failed ring on the same chain describes a leg that is no longer the story.

**Late evidence is not handled, on purpose.** A client-leg report arriving after the flip (40 minutes past the press) still writes `bridge_duration_sec` through `/status`, and a late `/dialend` is dropped by its `status = 'connected'` guard. The row stays `failed / bridge_unconfirmed`; the email has already gone. A Twilio report that late is not a realistic case, and un-flipping logic in a billed route would cost more than it protects.

Every statement that `connected` is "never reaped" becomes false and is corrected in the same change: `voiceConsultCall.js` (the press-1 target-validation comment and the `/dialend` JSDoc), the `CONSULT_CALLER_ID` block in `server/index.js`, the `CONSULT_CALLER_ID` env row in `.claude/CLAUDE.md`, and the `/digit` row in `ARCHITECTURE.md`.

### 4.4 The reaper moves under the consult sweep's switch

Today `reapStaleConsultCallAttempts` lives in `server/utils/vaCallingScheduler.js` and rides the hourly VA prune under `RUN_VA_CALLING_SCHEDULER`, while the sweep that opens and rings chains rides `RUN_CONSULT_CALL_SWEEP_SCHEDULER`. Sweep on with VA off strands `calling_*` rows holding a cap slot for 24 hours with no email.

The reaper (both arms) moves into its own module, `server/utils/consultCallReaper.js`, which the consult sweep runs on every 60-second tick, each arm in its own guard so a reap failure is recorded as a sweep fault and never masks the open, missed-window or ring steps, or the other arm. The UPDATEs are cheap on a table this size. Detection latency drops from up to an hour to about a minute; the 30-minute stale window itself does not change.

**With the switch off, the sweep still runs the stale arm** before returning its skipped shape. That arm's disabled branch parks a stranded chain `skipped_disabled` and emails nobody. If the sweep skipped it, those rows would sit until the switch came back on and then be reaped as failures, one email per consult, for a stop Dallas ordered. The bridge arm is a no-op while off (4.3). Nothing is dialed, opened or filed.

A stale-arm failure while the switch is off still fails the tick (normalized to an Error), matching the sweep's rule that faults rethrow rather than report green.

`vaCallingScheduler.js` stops touching consult rows. The env notes that describe the old wiring are corrected in `.claude/CLAUDE.md`, the README env table and `.env.example`: `RUN_VA_CALLING_SCHEDULER` no longer covers the consult reaper; `RUN_CONSULT_CALL_SWEEP_SCHEDULER` now owns it, and setting it `false` leaves no consult reaper at all (acceptable only while the feature is off, and said so); `CONSULT_CALL_ENABLED` no longer silences the sweep entirely, because the stale arm still parks rows while it is off.

### 4.5 Room in the chain file

`consultCallChain.js` is 995 lines and the hard cap blocks any commit that grows a file past 1000. `fileDialCapTrip` (28 lines plus its spacing) is dead: never called and never exported; `caps.fileCapTrip` replaced it. So is the two-line comment near the top about the `|| 10` fallback, which describes code that moved to `consultCallCaps.js`. Both are deleted first, which pays for 4.1 (including its 24-hour bound), 4.2, 6.1, 6.3 and 6.4. The budget was MEASURED during review by applying the exact planned edits to a copy of the file, not estimated; the plan re-measures before each commit that touches the file.

## 5. The duplicate consult

### 5.1 Root cause

`handleRescheduled` (`server/routes/calcom.js`) renames `consults.calcom_event_id` from the old uid to the new one. From then on, anything naming the old uid looks like a booking the system has never seen:

- A redelivered `BOOKING_CREATED` for the original booking. If its bytes are identical, the dedupe short-circuits, but the strand-heal sees the uid absent from `consults`, deletes the dedupe row and reprocesses, and `handleCreated` inserts a DUPLICATE consult at the abandoned slot. If the bytes differ at all, the dedupe never matches in the first place and the same duplicate is created. The sweep will ring it.
- A replayed `BOOKING_RESCHEDULED` superseded by a later reschedule. Its new uid was itself renamed away, so the heal reprocesses it, the in-place UPDATE matches nothing, and the fallthrough runs `handleCreated` with `unresolvedOldUid: true`. That inserts a duplicate at the superseded slot AND the tail stops every other upcoming consult sharing the booker's email, which includes the client's real one.
- A `BOOKING_CANCELLED` naming the moved-from uid misses the ON CONFLICT and inserts a junk `cancelled` consult row.

The ledger's first suggested fix (gate the heal on a consult sharing the booker and slot) would not work: after a reschedule, no consult sits at the old slot. Its second (record the resolved consult on the dedupe row) and a transactional dedupe both close only the identical-bytes path.

### 5.2 Fix: a consult remembers its prior Cal.com uids

Schema (idempotent, `server/db/schema.sql`, beside the other `consults` columns):

```sql
ALTER TABLE consults ADD COLUMN IF NOT EXISTS calcom_prior_event_ids TEXT[] NOT NULL DEFAULT '{}';
```

`handleRescheduled`'s in-place UPDATE appends the outgoing uid in the same statement (SET expressions read the pre-update row), except when the uid is not actually changing, so a consult never lists its own current uid as a prior one:

```sql
calcom_prior_event_ids = CASE WHEN calcom_event_id = $1 THEN calcom_prior_event_ids
                              ELSE array_append(calcom_prior_event_ids, calcom_event_id) END
```

The same UPDATE also resolves its old uid against the prior lists, not just the current column: `WHERE calcom_event_id = ANY($5) OR calcom_prior_event_ids && $5`, preferring a current-column match. If Cal.com ever names the ROOT booking on a second reschedule instead of the immediately previous one, today's lookup misses, and the fallthrough files a duplicate and stops the real consult. This is safe only because step 3 below rejects a known NEW uid first.

A "known uid" check, `calcom_event_id = $1 OR $1 = ANY(calcom_prior_event_ids)`, is used as-is in the first two places below. The last two need something narrower, for the reasons given:

1. **Strand-heal:** reprocess only when the uid is NOT known. The crash case it exists for (dedupe row committed, consult never written) still heals.
2. **`handleCreated` fast path:** a known uid commits and answers `Already filed`. The INSERT's ON CONFLICT stays the correctness boundary for two concurrent first deliveries.
3. **`handleRescheduled`, first step after the malformed-payload check:** the delivery is a replay when its NEW uid is in some consult's prior list, OR is a consult's CURRENT uid at the SAME slot (the slot compared in SQL, ruling R12). Answer `200 Already rescheduled`, run no UPDATE and no tail. A current uid with a DIFFERENT start time is not a replay: no real reschedule payload has ever been observed, so "Cal.com always mints a new uid" is unverified, and a same-uid time move must still go through the existing in-place path (review 2026-09-30).
4. **`handleCancelled`:** a uid found in some consult's prior list AND not any consult's current uid names a booking that already moved; answer `200 Booking already moved` and write nothing. This needs current and prior told apart, which the OR check cannot do. A current or never-seen uid keeps today's upsert unchanged.

Each of steps 3 and 4 writes one `console.log` line naming the uid, so a swallowed replay leaves a trace next to the booking it protected.

`handleNoShow` is unchanged: it only UPDATEs by the current uid.

**The unresolved fallthrough records what it replaces (per-lane database review, 2026-09-30).** When a reschedule's old uid resolves nowhere, the fresh consult `handleCreated` files stores the unmatched old-uid candidates (minus the new uid) as its prior list, so the late or retried CREATE of the booking it replaced is `Already filed` instead of a duplicate at the abandoned slot. The candidates can include Cal.com's numeric booking id; harmless, since only uid strings are compared against the list.

No index: `consults` holds tens of rows, and a sequential scan is the right plan at this size. `ARCHITECTURE.md`'s schema section gains the column.

## 6. The smaller guards

### 6.1 The kill switch covers press-1

`/answer` and `/digit` in `voiceConsultCall.js` check `isEnabled()` (exported by `consultCallChain.js`). Off:

- `/answer` speaks "The consult call bridge is turned off. Goodbye." and hangs up instead of reading the briefing.
- `/digit` with 1 speaks the same line, claims nothing and dials nothing. The check runs first, before the target validation, the still-scheduled guard and the claim, and the route's "order matters" comment names it.

**Rings 1 and 2 must park too (review blocker, 2026-09-30).** `onLegTerminal` checks the switch only on the ring-3 hop and the Zul leg. On ring 1 or 2 it re-arms the row to `pending`, and with the switch off the sweep never advances it: the row sits until the stale arm parks it 30 minutes after the slot, and if the switch comes back on first it either rings Dallas again or emails "too late" for a stop he ordered. Fix: the existing ring-3 switch check moves above the ring-1/2 re-arm, so ANY admin ring's terminal callback parks the chain `skipped_disabled` while off. The Zul leg keeps its own check. No new state.

### 6.2 Pressing 1 works during the repeat, on both bridges

`/answer` on both routers (`voiceConsultCall.js`, `voiceLeadCall.js`) currently wraps only the FIRST reading in `<Gather>`, then repeats it outside, so a digit during the repeat has no collector. New shape on both:

```xml
<Gather numDigits="1" timeout="10" method="POST" action="...">
  <Say>{briefing}</Say>
  <Pause length="1"/>
  <Say>{briefing}</Say>
</Gather>
<Hangup/>
```

A digit during either reading is collected. The 10-second wait now follows the second reading. Replay-with-9 and the three-play limit on the consult bridge are unchanged. The lead bridge's `/answer` is the only lead-bridge change in this work.

### 6.3 Zul's number never lands in the database

`placeLeg`'s create-failure write stores `err.code` when present, `'sid_unpersistable'` for that one internal throw, and the fixed word `'create_failed'` otherwise. It never stores `err.message`, which for a Twilio or network error can carry the dialed `To` number. The log line and the Sentry event receive a copy of the error whose message has the dialed number cut to its last four digits (per-lane security review, 2026-09-30): `VA_CELL` never reaches a DB record, a log line, or a third-party record.

**The success path leaked too (review 2026-09-30).** `caps.recordLegAudit` (`server/utils/consultCallCaps.js`) writes the dialed number into `call_audit.target_e164` for every placed leg, so every Zul leg stored her full number. The consult caps count by `status`, never by number, so the Zul leg now records `target_e164` NULL (the column is nullable). The admin leg keeps its US number. Prod holds two such rows (2026-09-08 and 2026-09-18); `call_audit` is pruned at 30 days, so both age out by 2026-10-18 and no data fix is run.

### 6.4 Both dial targets are format-checked

`placeLeg` tests the target VERBATIM against the strict E.164 pattern already in the file before calling Twilio (no trimming, so the dial-target law "dialed verbatim" still holds for anything that passes). A malformed `ADMIN_PHONE` or `VA_CELL` is never handed to Twilio: the leg is recorded `create_failed` with detail `invalid_dial_target` (ring-guarded on the admin leg, as the existing failure write is) and `placeLeg` returns false, so the caller runs the existing failed-leg path and the chain ends in the same email it would today.

Deliberately NOT treated as unset. Unset with no Zul files `skipped_unconfigured` with no email, so treating a typo as unset would make it quieter than it is now.

`server/index.js` gains a boot warning for each of `ADMIN_PHONE` and `VA_CELL` when SET but not strict E.164 (unset is a legitimate configuration and stays silent), in the same shape as the `CONSULT_CALLER_ID` block: `console.warn` plus a Sentry warning. The message never echoes the value (a mistyped `VA_CELL` is still Zul's number, and Sentry is a third-party record), and it is worded as the SHARED setting it is: `ADMIN_PHONE` also drives the lead bridge and several admin texts, so the tag is `subsystem: 'phone-config'` and the text says the consult bridge will not dial it, not that only the consult bridge is affected. It has no automated test (neither does its sibling); the plan carries a manual boot check.

**Deploy compatibility (review 2026-09-30).** A check that is stricter than today's truthiness test could stop every ring after deploy if a live value carries a stray space. Prod `call_audit`, read-only, shows all 9 consult legs ever placed (7 admin, 2 Zul, 2026-09-08 through 2026-09-18) went to strict E.164 numbers, so the current Render values pass unless they were edited after 2026-09-18. The boot warning reports it on the deploy that matters either way.

## 7. Documentation and ledger

At merge:

- Ledger (`docs/fix-list-remaining-2026-07-02.md`): delete the section 0 entries and their one-screen rows, and the section 3 "Pressing 1 during the automatic repeat" entry (it has no one-screen row). Add one Settled line: the sibling stop keeps `skipped_cancelled` / `rescheduled_unresolved`; a status of its own was decided against 2026-09-30 because the one-row email closed the silence and a rename changes no behavior.
- Code comments that say the write side still owes a status, or that the chain emails only for more than one row: `server/routes/admin/leadCalls.js` (the `skipped_cancelled` note), `client/src/utils/consultCallLabel.js` (the `rescheduled_unresolved` note), `server/utils/emailTemplates.js` (the banner note), `consultCallChain.js` (the gate comment).
- Every "`connected` is never reaped" statement (4.3's list).
- `.claude/CLAUDE.md`, `README.md` and `.env.example`: the `RUN_VA_CALLING_SCHEDULER`, `RUN_CONSULT_CALL_SWEEP_SCHEDULER`, `CONSULT_CALL_ENABLED` and `CONSULT_CALLER_ID` rows (4.3, 4.4).
- `ARCHITECTURE.md`: the new `consults` column and the webhook's prior-uid behavior; both `/answer` rows (the repeat now sits inside the Gather); the consult `/digit` row (switch first; `connected` is reaped); the sweep bullet (five steps, "after every step"); the reaper bullet; the consult Writers line; the consult Alerts line (4.1's bound and the four new email reasons).
- `README.md` folder tree: the new `consultCallReaper.js` row, and the `consultCallSweep.js` / `vaCallingScheduler.js` rows.
- `docs/walkthroughs-owed.md`: after deploy, one real billed walk on a synthetic consult in the 2026-08-26 shape: press 1 during the SECOND reading and confirm the bridge connects. The kill-switch half is NOT walkable (review 2026-09-30): with the switch off the sweep places no ring, and a Render env change restarts the service, which outlives a 20-second ring placed before the flip. The off message and the ring-1/2 parking are proven by the route and chain tests instead.

## 7a. Lanes

Two lanes, both unblocked and buildable in parallel in separate worktrees (review 2026-09-30):

- **`calcom-prior-uids`**: section 5 alone (`schema.sql`, `calcom.js`, its suite, its `ARCHITECTURE.md` lines). A public-webhook change resting on an unverified Cal.com payload assumption gets its own squash commit, so it can be reverted without pulling out the rest.
- **`consult-bridge-hardening`**: sections 4 and 6.

Both touch `ARCHITECTURE.md` in different sections; the second to merge resolves that conflict, if git raises one.

## 8. Testing

Every behavior below gets a test that fails on today's code and passes after. Server suites share the dev database, so they run one at a time from the repo root.

- `calcom.test.js`: a redelivered CREATE after a reschedule makes no duplicate, with identical bytes (heal path) and with different bytes (fresh path); a superseded RESCHEDULED replayed after a second reschedule makes no duplicate and stops nothing; a replay of the LATEST reschedule is a no-op; a same-uid reschedule to a NEW time still moves in place and never lists its own uid as prior; a reschedule naming the ROOT uid after a first move resolves in place; a CANCELLED naming a moved-from uid writes nothing; the crash heal still reprocesses a never-seen uid; the reschedule UPDATE records the prior uid.
- `consultCallChain.test.js`: one stopped sibling sends exactly one email, a second stop for the same booker email the same Chicago day sends none, and a stop the next day does; `notifyClientNoAnswer` sends the text and no email on `'sent'`, and the right reason on each non-sent result; with the switch off, a ring-1 terminal callback parks the chain `skipped_disabled` instead of re-arming it; a thrown error with no code and a `+63` number in its message never reaches `detail` or the log line; a placed Zul leg's `call_audit` row carries no number; a malformed target is never passed to `placeBridgedCall` and records `invalid_dial_target`.
- `voiceConsultCall.test.js`: switch off at `/answer` (off message, no briefing) and at press-1 (no claim, no `<Dial>`); both readings sit inside the `<Gather>`; `/dialend` calls `notifyClientNoAnswer` only for the latch winner, and answers Twilio even when that call never settles.
- `voiceLeadCall.test.js`: both readings inside the `<Gather>`.
- `consultCallSweep.test.js`: both reaper arms run from the tick, a reap failure costs neither the ring step nor the other arm, and with the switch off only the stale arm runs.
- `consultCallReaper.test.js` (new, taking over the consult reaper tests from `vaCallingScheduler.test.js`): the unconfirmed arm flips and emails once; it never flips a row with a duration, a no-answer latch, time still inside the limit, or with the switch off; a row parked while off stays parked when the switch returns.
- `vaCallingScheduler.test.js`: the VA prune no longer reaps consult rows.
- `emailTemplates.consultCall.test.js`: the three new banners and the reworded one render.
- `consultCallLabel.test.js` and `queueItems.test.js`: `bridge_unconfirmed` reads `pressed 1, bridge unconfirmed` on the detail line and in the Needs attention headline.
- `server/index.js` boot warning: a manual check (boot once with a malformed `ADMIN_PHONE`, once with it unset).
- `calcom.test.js` also owns the schema check, because `schema.vaCalling.test.js` applies only the slice from the VA-calling banner to EOF, which does not reach the `consults` statements: the suite applies the ALTER it reads out of `schema.sql` (idempotent, additive) and asserts the column exists, is NOT NULL, and defaults to an empty array.

## 9. Review

`calcom.js` is webhook code and the consult modules are sensitive-listed, so EACH lane gets the full fleet before merge. The new `server/utils/consultCallReaper.js` matches no existing glob (the consult modules are listed by exact path; only `*Scheduler.js` covered the reaper's old home), so it is added to `scripts/sensitive-paths.txt` in the same change. The push-time sensitive re-review and `/second-opinion` run at push as usual.

Also folded in at per-lane review: the dial-cap and international-leg-cap emails (`daily dial cap tripped`, `daily international-leg cap tripped`, sent by `consultCallCaps.fileCapTrip`) get their own call-them-by-hand banners instead of the generic "check the system" line; `consultCallCaps.js` joins the sensitive-path list; the unconfirmed-bridge label is one shared constant, exported like `consultCapLabel`.

Declined at review, with reasons: exporting `timeLimitSec` from the chain file (the house pattern is a local copy per file, and the chain file has no room); keeping an earlier Twilio code instead of `bridge_unconfirmed` in `detail` (both labels key on that value); a review agent at every in-lane checkpoint (the full fleet per lane before merge is the gate); un-flipping a row on a very late client-leg report (4.3).

## 10. Out of scope

- The lead bridge's own chain, beyond the one TwiML change in 6.2.
- `skipped_unconfigured` emailing. Both targets unset is a deliberate configuration, and the feed already lists it.
- A runtime format check on `VOICE_CALLER_ID` at press-1. The unconfirmed-bridge check in 4.3 reports the fallout of a bad caller ID whatever its cause.
- Cal.com V2 (self-host, branding, embed).
