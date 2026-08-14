# Shift lifecycle: "has it finished yet", not "what day is it"

Date: 2026-08-14. Owner call: Dallas, "your call", after three failed rounds across two lanes.

## Why this exists

Two lanes were cut for what looked like two bugs and turned out to be one:

- **`current-date-shift-visibility`** — SQL `CURRENT_DATE` is the GMT day (session TimeZone is
  `GMT`, verified), so `event_date >= CURRENT_DATE` stopped matching today's shifts at 19:00
  Chicago. Tonight's shift vanished from the staff Available tab, the admin assign modal, the
  staffer's own next-shift card, and the SMS responder.
- **`shift-closure`** — nothing in this system has ever closed a shift. Only 5 shifts in prod
  have ever reached `completed`; `filled` has never been used. 50 sit `open` on completed
  proposals, 31 of them with `payout_events` attached.

They broke each other. Widening visibility to the whole Chicago day made a shift that ENDED
this morning outrank tonight's, because the `NOT IN ('completed','cancelled')` guard cannot
exclude a finished shift when nothing ever marks one finished. That is a **P0**: a bartender
texting CANT at 20:00 about tomorrow gets today's finished brunch shift denied and reopened,
removing someone who actually worked from the roster payroll pays from. Meanwhile the closure
lane grew a date gate to avoid closing future-dated shifts, and that gate had no "later pass"
because `processEventCompletions` never re-selects an already-completed proposal.

Circular, and the circle exists because **both lanes asked the wrong question.** "Is this shift
dated today or later" is a proxy. The real question is "has this shift finished yet."

## The decision

Define a shift's END INSTANT, and derive everything from it.

`upcoming` means the end instant is in the future. `finished` means it is in the past. No
calendar-day arithmetic anywhere in the shift-visibility family, so no timezone boundary to get
wrong and no dependency on closure having run.

The codebase already trusts this shape: `balanceScheduler.js:228` completes an EVENT with
`((event_date + event_start_time::time + (event_duration_hours || ' hours')::interval) AT TIME
ZONE event_timezone) < NOW()`, guarded by a regex against the free-text time column. This spec
is the same idea applied to a SHIFT.

## The predicate, and the null problem

Measured against prod: 78 shifts. `end_time` is `VARCHAR(50)` and **NULL on 14 of them**.
`start_time` is NULL on 3. Five shifts have no `proposal_id` at all, and those five are exactly
five of the fourteen with no end time. Zero of the 64 populated `end_time` values fail the
parse regex. Every proposal row is `America/Chicago`; the column is still honored rather than
assumed.

A shift's end instant:

1. `end_time` present and matching `^[0-9]{1,2}:[0-9]{2}( ?[AP]M)?$` →
   `(event_date + end_time::time) AT TIME ZONE tz`, where `tz` is the proposal's
   `event_timezone`, falling back to `America/Chicago` when there is no proposal.
2. Otherwise → **end of that calendar day in `tz`**, i.e. `(event_date + 1 day) AT TIME ZONE tz`.

Rule 2 is deliberately **fail-safe toward visible**. Hiding a shift too early is the entire bug
being fixed; keeping an unknown-duration shift listed until midnight is the harmless direction.
A malformed `end_time` takes rule 2 as well, never a parse error.

## What changes

**Visibility.** Every member of the family stops asking about the calendar day and asks whether
the end instant has passed: the staff Available tab (`STAFF_OPEN_SHIFTS_SQL`), the admin
`GET /shifts/unstaffed-upcoming`, the staff-home next-shift card, its open-shifts teaser and
"All (N)" count, pending requests, cover broadcasts, `findNearestApprovedShift`, the message
invitation picker, and `outstandingDocuments`. Count and list must share the predicate so the
documented mirrors cannot diverge again — that pairing is what broke in round 1.

**Closure.** Stop hanging closure off the proposal-completion doors. A shift closes when the
SHIFT has finished, which makes the future-dated case fall out for free and removes the
"no later pass" hole entirely. That means a recurring sweep over shifts whose end instant has
passed on a completed proposal, which is the backfill's query on a schedule. Terminal status is
always `completed`, never `cancelled` — `cancelled` is read as an EVENT-cancelled signal by
`adminos/shifts.js` `isCancelledEvent` and by `calendar.js` (`STATUS:CANCELLED` with a bumped
`SEQUENCE`), and marking a delivered paid event that way struck two real events off the owner's
Google Calendar in an earlier round.

## Explicitly out

- `server/utils/balanceScheduler.js` lines 55-120: the Stripe autopay idempotency key mirrored
  by `stripe.js:340`. A divergence removes the only guard against a duplicate balance charge.
  Byte-identical or the lane fails.
- **`autoAssignScheduler.js` must be REVERTED** to `CURRENT_DATE`. A previous round converted it;
  it is an ACTION trigger, not a visibility predicate, and the conversion moved staff
  auto-approval SMS from ~19:00 to just after midnight Chicago with no quiet-hours gate.
- Marketing windows measured in months, payroll lookback windows, and calendar ±day ranges. A
  one-day shift is immaterial there and churn is not free.

## Known-open, deliberately not in scope

- `staffPortal.js` pay-period lookup is the last `WHERE CURRENT_DATE BETWEEN ...` of the payroll
  "which period is now" family; every sibling passes `chicagoTodayYmd()`. On a period's last
  evening the Pay card resolves the next period while accrual writes the current one. Money
  path, wants its own lane.
- `marketingAudience.js:206/230` carry no band at all, so the months-scale carve-out does not
  actually cover them.
- `scripts/backfill-positions-needed.js:94` sits outside `server/` and was missed by the sweep.
- `PUT /shifts/:id` takes `status` off the request body with no allowlist, a fourth and
  unintended writer of `shifts.status`.

## Verification law for this work

The database clock cannot be mocked, so a test that only mocks the process clock proves
nothing. Reuse the technique that worked: read the DB's own `CURRENT_DATE` as `D`, seed fixtures
around it, pin the PROCESS clock with `node:test` mock timers to a real instant via
`eventLocalToUtc`, and assert the premise loudly in `before()` so a broken premise fails rather
than passing silently. Every changed site needs a test that fails before and passes after, at
`TZ=UTC` and `TZ=America/Chicago` both, because the process timezone is not what causes this
bug and a single-TZ test is how it hid for so long.
