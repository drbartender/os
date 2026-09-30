# Consult Call Bridge Hardening (fix list section 0)

Design, 2026-09-30. Brainstormed section by section with Dallas; all four sections were approved in chat. This document is the contract for the plan and the build. It closes section 0 of `docs/fix-list-remaining-2026-07-02.md` ("The consult call bridge is LIVE, and these are reachable right now") plus the section 3 entry "Pressing 1 during the automatic repeat does nothing, on BOTH bridges".

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

`consultCallTail` (`server/utils/consultCallChain.js`), the unresolved-reschedule branch: the email gate `marked.rowCount > 1` becomes `marked.rowCount > 0`. Still ONE email per tail call (never one per row: the booking page is public and these rows sit outside the daily cap, so a per-row loop would be a Resend-quota amplifier). The attempt passed to `sendChainEmail` is still `marked.rows[0]`, a stopped sibling, so the email names the slot that will NOT ring.

The comment above the gate is rewritten to say why one row now emails: the one-row case is exactly "the victim had one real consult", and the email cannot tell that apart from the booker moving their own slot, so it goes to a human either way.

The `unresolved reschedule` banner (`CONSULT_CALL_BANNERS`, `server/utils/emailTemplates.js`) is reworded to fit one row or many:

> Someone rescheduled using this booker's email and we could not tell which booking moved, so the call for this slot was stopped and will not ring. If this is the slot they moved away from, there is nothing to do. If not, call them at the slot.

The template's comment that says the banner is "only sent when more than one row was stopped" is corrected.

### 4.2 A failed client-no-answer text becomes the email

Today `/dialend` (`server/routes/voiceConsultCall.js`) calls `sendMissedText({ kind: 'client_no_answer' })` and discards the result. Its sibling `finishMissed` turns an unsent text into the one admin email.

New export in `consultCallChain.js`: `notifyClientNoAnswer({ attemptId })`. It sends the `client_no_answer` text; when the discriminated result is anything but `'sent'` it sends the one chain email with a reason from its own Map (same Map-not-object-literal rule as `MISSED_TEXT_EMAIL_REASON`):

| `sendMissedText` result | email reason |
|---|---|
| `no_destination` | `client no answer, no text destination` |
| `send_failed` | `client no answer, text failed` |
| `no_attempt` | `client no answer, text failed` |

It never throws. `/dialend` calls it in place of `sendMissedText`, still only for the latch winner (text-exactly-once law unchanged). The route's test seam swaps accordingly.

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

`client/src/utils/consultCallLabel.js` gains a detail branch so the proposal and client detail pages read `pressed 1, bridge unconfirmed` for this row rather than the generic failed label.

### 4.4 The reaper moves under the consult sweep's switch

Today `reapStaleConsultCallAttempts` lives in `server/utils/vaCallingScheduler.js` and rides the hourly VA prune under `RUN_VA_CALLING_SCHEDULER`, while the sweep that opens and rings chains rides `RUN_CONSULT_CALL_SWEEP_SCHEDULER`. Sweep on with VA off strands `calling_*` rows holding a cap slot for 24 hours with no email.

The reaper (both arms) moves into the consult sweep and runs on every 60-second tick, in its own guard so a reap failure is recorded as a sweep fault and never masks the open, missed-window or ring steps (and vice versa). The UPDATEs are cheap on a table this size. Detection latency drops from up to an hour to about a minute; the 30-minute stale window itself does not change.

`vaCallingScheduler.js` stops touching consult rows. The env notes that describe the old wiring are corrected: `RUN_VA_CALLING_SCHEDULER` and `RUN_CONSULT_CALL_SWEEP_SCHEDULER` in `.claude/CLAUDE.md` and the README env table.

### 4.5 Room in the chain file

`consultCallChain.js` is 995 lines and the hard cap blocks any commit that grows a file past 1000. `fileDialCapTrip` (about 28 lines) is dead: never called and never exported; `caps.fileCapTrip` replaced it. It is deleted first, which pays for 4.2, 4.1's comment and 6.3.

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

`handleRescheduled`'s in-place UPDATE appends the outgoing uid in the same statement (SET expressions read the pre-update row):

```sql
calcom_prior_event_ids = array_append(calcom_prior_event_ids, calcom_event_id)
```

One "known uid" predicate, `calcom_event_id = $1 OR $1 = ANY(calcom_prior_event_ids)`, defined once and used in four places:

1. **Strand-heal:** reprocess only when the uid is NOT known. The crash case it exists for (dedupe row committed, consult never written) still heals.
2. **`handleCreated` fast path:** a known uid commits and answers `Already filed`. The INSERT's ON CONFLICT stays the correctness boundary for two concurrent first deliveries.
3. **`handleRescheduled`, first step after the malformed-payload check:** if the NEW uid is already known, the delivery is a replay: answer `200 Already rescheduled`, run no UPDATE, no tail, no Sentry warning.
4. **`handleCancelled`:** a uid found in some consult's prior list (and not current) names a booking that already moved; answer `200 Booking already moved` and write nothing. A current or never-seen uid keeps today's upsert unchanged.

`handleNoShow` is unchanged: it only UPDATEs by the current uid.

No index: `consults` holds tens of rows, and a sequential scan is the right plan at this size. `ARCHITECTURE.md`'s schema section gains the column.

## 6. The smaller guards

### 6.1 The kill switch covers press-1

`/answer` and `/digit` in `voiceConsultCall.js` check `isEnabled()` (exported by `consultCallChain.js`). Off:

- `/answer` speaks "The consult call bridge is turned off. Goodbye." and hangs up instead of reading the briefing.
- `/digit` with 1 speaks the same line, claims nothing and dials nothing. The check runs first, before the target validation, the still-scheduled guard and the claim.

The agent leg's own status callback then files the chain `skipped_disabled` through the existing `onLegTerminal` / `advanceChain` paths. No new state.

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

`placeLeg`'s create-failure write stores `err.code` when present, `'sid_unpersistable'` for that one internal throw, and the fixed word `'create_failed'` otherwise. It never stores `err.message`, which for a Twilio or network error can carry the dialed `To` number. (Sentry still receives the error object; the invariant is that `VA_CELL` never reaches a DB record.)

### 6.4 Both dial targets are format-checked

`placeLeg` tests the target VERBATIM against the strict E.164 pattern already in the file before calling Twilio (no trimming, so the dial-target law "dialed verbatim" still holds for anything that passes). A malformed `ADMIN_PHONE` or `VA_CELL` is never handed to Twilio: the leg is recorded `create_failed` with detail `invalid_dial_target` (ring-guarded on the admin leg, as the existing failure write is) and `placeLeg` returns false, so the caller runs the existing failed-leg path and the chain ends in the same email it would today.

Deliberately NOT treated as unset. Unset with no Zul files `skipped_unconfigured` with no email, so treating a typo as unset would make it quieter than it is now.

`server/index.js` gains a boot warning for each of `ADMIN_PHONE` and `VA_CELL` when SET but not strict E.164 (unset is a legitimate configuration and stays silent), in the same shape as the `CONSULT_CALLER_ID` block: `console.warn` plus a Sentry warning tagged `subsystem: 'consult-call'`.

## 7. Documentation and ledger

At merge:

- Ledger (`docs/fix-list-remaining-2026-07-02.md`): delete the section 0 entries and their one-screen rows, and the section 3 "Pressing 1 during the automatic repeat" entry and its row. Add one Settled line: the sibling stop keeps `skipped_cancelled` / `rescheduled_unresolved`; a status of its own was decided against 2026-09-30 because the one-row email closed the silence and a rename changes no behavior.
- Code comments that say the write side still owes a status, or that the chain emails only for more than one row: `server/routes/admin/leadCalls.js` (the `skipped_cancelled` note), `client/src/utils/consultCallLabel.js` (the `rescheduled_unresolved` note), `server/utils/emailTemplates.js` (the banner note), `consultCallChain.js` (the gate comment).
- `.claude/CLAUDE.md` and `README.md`: the two scheduler env rows (4.4).
- `ARCHITECTURE.md`: the new `consults` column.
- `docs/walkthroughs-owed.md`: after deploy, one real billed walk on a synthetic consult in the 2026-08-26 shape. Press 1 during the SECOND reading and confirm the bridge; then flip `CONSULT_CALL_ENABLED=false`, let a ring answer, and confirm the off message and that no client leg is placed. Flip it back and confirm a chain opens (a kill-switch state is confirmed only by observing behavior).

## 8. Testing

Every behavior below gets a test that fails on today's code and passes after. Server suites share the dev database, so they run one at a time from the repo root.

- `calcom.test.js`: a redelivered CREATE after a reschedule makes no duplicate, with identical bytes (heal path) and with different bytes (fresh path); a superseded RESCHEDULED replayed after a second reschedule makes no duplicate and stops nothing; a CANCELLED naming a moved-from uid writes nothing; the crash heal still reprocesses a never-seen uid; the reschedule UPDATE records the prior uid.
- `consultCallChain.test.js`: one stopped sibling sends exactly one email; `notifyClientNoAnswer` sends the text and no email on `'sent'`, and the right reason on each non-sent result; a thrown error with no code and a `+63` number in its message never reaches `detail`; a malformed target is never passed to `placeBridgedCall` and records `invalid_dial_target`.
- `voiceConsultCall.test.js`: switch off at `/answer` (off message, no briefing) and at press-1 (no claim, no `<Dial>`); both readings sit inside the `<Gather>`; `/dialend` calls `notifyClientNoAnswer` only for the latch winner.
- `voiceLeadCall.test.js`: both readings inside the `<Gather>`.
- `consultCallSweep.test.js`: the reaper runs from the sweep tick and a reap failure does not stop the ring step; the unconfirmed arm flips and emails once; it never flips a row with a duration, a no-answer latch, time still inside the limit, or with the switch off.
- `vaCallingScheduler.test.js`: the VA prune no longer reaps consult rows.
- `emailTemplates.consultCall.test.js`: the three new banners and the reworded one render.
- `consultCallLabel.test.js`: `bridge_unconfirmed` reads `pressed 1, bridge unconfirmed`.
- `server/db/schema.vaCalling.test.js` (the suite that already asserts this feature's columns through `information_schema.columns`): the column exists, is NOT NULL, and defaults to an empty array.

## 9. Review

`calcom.js` is webhook code and the consult modules are sensitive-listed, so the lane gets the full fleet before merge. The push-time sensitive re-review and `/second-opinion` run at push as usual.

## 10. Out of scope

- The lead bridge's own chain, beyond the one TwiML change in 6.2.
- Sentry receiving Twilio error messages (6.3 keeps the DB clean only).
- `skipped_unconfigured` emailing. Both targets unset is a deliberate configuration, and the feed already lists it.
- A runtime format check on `VOICE_CALLER_ID` at press-1. The unconfirmed-bridge check in 4.3 reports the fallout of a bad caller ID whatever its cause.
- Cal.com V2 (self-host, branding, embed).
