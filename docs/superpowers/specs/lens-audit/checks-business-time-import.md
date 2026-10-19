# Lens synthesis: time-date and data-import

Input: `synth-in/time-import.jsonl`, 105 defects. time-date 65 (29 money, 9 open; found by fleet 17, audit 13, external 9, self 9, prod 5, test 1, dallas 1, unknown 10). data-import 40 (22 money, 10 open; found by fleet 11, self 9, audit 3, prod 3, dallas 2, external 1, unknown 11).

Why no lens caught any of these: the six checklists (`checks/*.md`) contain no check that mentions a timezone, a day boundary, a pay period, a business day, an import, a backfill, a seed, or a script. The only timestamp line in the whole set is DAT-18 ("timestamps have DEFAULT NOW()"). database-review's query scope (DAT-08) is "every file in `server/routes/` and `server/utils/`", which excludes `server/scripts/` and `scripts/`, where 25 of the 40 import defects live. Both classes are therefore outside every lens by construction, not by oversight on a particular review.

Repo anchors the checks below name (verified against `/home/drbartender/projects/os` on 2026-10-19):

- `server/utils/businessTime.js` exports `chicagoTodayYmd()`, `chicagoYmdOf(instant)`, `chicagoHourNow()`, `eventLocalToUtc(ymd, h, m, tz)`. The Postgres session runs GMT on dev and prod, so `CURRENT_DATE` and `NOW()::date` roll over at 19:00 Chicago (18:00 in winter).
- `server/utils/shiftEndInstant.js` exports `shiftEndInstantSql`, `shiftNotFinishedSql`, `shiftFinishedSql`, `SHIFT_TIME_RE`. `server/utils/eventEndInstant.js` exports `eventEndInstant`, `eventEndInstantForDuration`, `maxDurationHoursBeforeCurfew`. `server/utils/serviceCurfew.js` owns `PARSEABLE_TIME`. `server/utils/eventTimezone.js` owns `resolveEventTimezone(proposal)`.
- `server/utils/payrollPeriods.js` exports `payPeriodForDate(ymd)`; `pay_periods` rows are minted lazily by accrual, 0 to 4 days into their own week.
- Client: `components/adminos/format.js` has `fmtDate` / `fmtDateFull` (input MUST be a bare `YYYY-MM-DD`; they append `T12:00:00` and return the dash placeholder on anything else), `fmtDateOnly` (slices to 10 first), `fmtDateTime` and `ctDay` (instants). `utils/chicagoDay.js` has `chicagoDay` / `chicagoTime` / `chicagoInstant`; `hooks/useMetricsFilter.js` has `chicagoYmdParts`.
- No pg type parser is installed in `server/db/index.js`: a DATE column arrives server-side as a JS `Date` at process-local midnight (so `String(d).slice(0,10)` yields `"Thu Jun 12"`) and reaches the browser through `res.json` as a full ISO string; a TIMESTAMPTZ arrives as a JS `Date` truncated to milliseconds while Postgres stores microseconds.
- Live footprint today, non-test: 38 `toISOString().slice(0,10)` sites, 29 `timeZone: 'UTC'` literals, 79 `toLocaleDateString` / `setDate` / `getDate` calls in `client/src`, `ymd10` hand-rolled in 9 payroll files, `toCalendarYmd` in 4 server files, `wholeDaysBetween` in 2, `chicagoTodayYmd` re-implemented in `client/src/pages/admin/overview/PayrollStatus.js`.
- The test seam the repo already uses for day boundaries: `_deps.today` (staffPortal.js, clientPortal.js, balanceScheduler.js, contractorSeed.js), run under both `TZ=UTC` and `TZ=America/Chicago`.

Two NEW lenses are proposed: **business-time** (every clock, calendar and zone question; today these straddle database-review, code-review and ui-ux-review and none of them asks) and **import-backfill** (scripts, one-time DO blocks, external-feed ingestion; today no lens reads them at all). Where a check could live in an existing lens instead, it says so.

---

## Class: time-date (65 defects)

What keeps going wrong: the business runs on a Chicago wall clock, the database session runs GMT, the browser runs wherever the viewer is, and a DATE column is a day while a TIMESTAMPTZ is an instant. Every defect in this class is one of those four facts being resolved in the wrong frame. Twelve queries asked Postgres for "today" and got the GMT day, so from 19:00 Chicago tonight's shift vanished, a hire was stamped tomorrow, a balance due tomorrow was charged tonight, and a pay period that did not exist yet was looked up. Nine JS sites sliced the UTC day off an instant, so a payout paid at 8:30 PM printed the next day and Monday-evening clawbacks landed in next week's period. Eleven call sites fed a formatter the wrong shape (a pg `Date` where text was expected, a full ISO string where a bare day was expected), and because every formatter swallows a bad input into a dash placeholder or `Invalid Date`, nothing threw in a test: payroll panels showed dashes for a whole release and every client SMS read `Invalid Date`. Seven lifecycle predicates asked "is the shift's date today or later" instead of "has the shift ended", and the two answers disagree twice a day; the worst two were P0s that re-opened an already-worked shift and took a bartender off the roster payroll pays from. The rest are hour windows that cannot wrap midnight, microsecond timestamps compared through a millisecond round trip, and day-count thresholds whose unit silently changed. The recurring meta-failure: the UTC and Chicago days agree about 19 hours in 24, so a fix verified against the live clock stays green against the very bug it claims to fix, and three of these were marked fixed while still present.

### Checks

1. **SQL "today" and "this year" resolve in the business frame.** Any `CURRENT_DATE`, `NOW()::date`, `date_trunc(..., NOW())`, `EXTRACT(... FROM <timestamptz>)`, or a timestamp-without-zone compared to `NOW()` inside a query that touches `event_date`, `hire_date`, `balance_due_date`, `paid_at`, `tipped_at`, or `pay_periods` bounds must instead bind `chicagoTodayYmd()` as a parameter (`$n::date`) or wrap the column in `AT TIME ZONE COALESCE(p.event_timezone, 'America/Chicago')`. A comment saying "Chicago business day" next to a bare `CURRENT_DATE` is a finding, not a pass.
   Trigger: the diff adds or edits a SQL string containing `CURRENT_DATE`, `NOW()`, `EXTRACT(`, `date_trunc(`, or `::date` within 10 lines of one of those columns. Grep the whole file, not just the hunk; D2298 had two sites in one file.
   Lens: NEW: business-time (could sit in database-review query analysis, but that lens's scope excludes schedulers' SQL in practice).
   Defects: D2297, D2298, D2303, D2311, D2312, D2315, D2325, D2326, D2329, D2330, D2335, D2350 (12).
   Docs to read: the 1099 year is the Chicago year of `paid_at` (D2297); the autopay claim date and the completion gate are in `reference-payroll-completion-gate` (D2329, D2330).

2. **A calendar day derived from an instant goes through the Chicago helper.** When code turns an instant (`new Date()`, `Date.now()`, a TIMESTAMPTZ value such as `paid_at`, `cancelled_at`, `tipped_at`) into a day, it must call `chicagoYmdOf` / `chicagoTodayYmd` on the server or `chicagoDay` / `chicagoYmdParts` on the client. Flag `toISOString().slice(0,10)`, `String(ts).slice(0,10)` on a timestamp, `getFullYear()/getMonth()/getDate()` on an instant, `toLocaleDateString` with no `timeZone`, and any local `toYmd`/`toCalendarYmd` helper that does one of those.
   Trigger: the diff contains `.slice(0, 10)`, `.slice(0,10)`, `toISOString()`, `getDate()`, or `toLocaleDateString(` applied to a value whose column is TIMESTAMPTZ, or introduces a "today" constant.
   Lens: NEW: business-time.
   Defects: D2272, D2283, D2285, D2293, D2305, D2308, D2344, D2345, D2346 (9).
   Docs to read: a paid date is the Chicago day of `paid_at` on screen, PDF and 1099 alike (D2283, D2285, D2346); the 14-day cancel branch counts from the Chicago day of `cancelled_at` (`docs/ops-runbook.md`, D2305).

3. **A DATE column is a day, never an instant.** `event_date`, `balance_due_date`, `hire_date`, `payday`, period bounds and invoice due dates must never be parsed with a bare `new Date(ymd)` (UTC midnight, the previous day in Chicago), never adjusted with `setDate`/`getDate`, and never compared to a TIMESTAMPTZ with `<=` on the upper bound (a date-only `to` becomes that day's midnight; use `< to + 1 day`). When a day must become an instant (a reminder anchor, a countdown), compose it in the event's zone with `eventLocalToUtc` or `AT TIME ZONE`, and define that anchor once. Copy that says "today" or "tomorrow" must be computed at send time from `chicagoTodayYmd()`, never frozen at schedule time.
   Trigger: the diff touches any of those columns together with `new Date(`, `Date.parse(`, `setDate(`, `T00:00:00`, `Date.UTC(`, a `<=` against a `*_at` column, or the words "today"/"tomorrow" in a template.
   Lens: NEW: business-time (the half-open bound clause is also a database-review question).
   Defects: D2268, D2279, D2295, D2327, D2338, D2349 (6).
   Docs to read: the balance-due anchor and its reschedule re-anchor must be one definition (D2349); the tips ledger total is `tipped_at` on the Chicago day (D2295).

4. **Every date formatter has an input contract; prove the value's shape at the call site.** `fmtDate`/`fmtDateFull` take only a bare `YYYY-MM-DD`; `fmtDateOnly` slices; `fmtDateTime`/`ctDay`/`chicagoDay` take instants; server `String(d).slice(0,10)` takes text only. A pg DATE arrives server-side as a JS `Date` and in the browser as a full ISO string, so trace the value from its SELECT (or from the API payload) to the formatter and state its shape. Any formatter whose failure mode is a placeholder (the dash string, `null`, `Invalid Date`, `NaN`) rather than a throw needs a test that asserts the rendered text, not the absence of an error.
   Trigger: a new or moved call to any `fmt*Date*`, `formatEventDateForSms`, `toCalendarYmd`, `String(x).slice`, or a date template variable; a new SELECT of a DATE column that feeds a template; a route that starts returning a DATE as a `Date` where it returned text (or vice versa).
   Lens: NEW: business-time (the client half is also a ui-ux-review question: a panel of dashes is an empty state that is not empty).
   Defects: D2270, D2271, D2274, D2275, D2276, D2278, D2282, D2301, D2339, D2347, D2353 (11).
   Docs to read: none; the contract is in the formatter headers.

5. **Time and date values crossing an external or legacy boundary are normalized to the canonical shape and zone at load.** Thumbtack lead instants are UTC and must land in America/Chicago (not Eastern) as 24h `HH:MM`; TimePicker, iCal and any parser of `shifts.start_time`/`end_time`/`proposals.event_start_time` must accept all three live dialects (`7:00 PM`, `6:00PM`, `19:00`) via `PARSEABLE_TIME` or `SHIFT_TIME_RE`, and every writer must emit canonical 24h; Check Cherry `MM-DD-YYYY` becomes ISO at load. Assert the canonical shape before persisting, because a stored `NaN:NaN` or a wrong-zone time poisons every downstream formatter.
   Trigger: the diff parses or writes one of those columns, adds a regex on a time string, calls a 12h-to-24h converter, or reads a date/time from a webhook payload, a CSV, or a feed.
   Lens: NEW: business-time (the import half belongs to import-backfill check 6 below).
   Defects: D2269, D2302, D2322, D2361, D2362 (5).
   Docs to read: `project-thumbtack-autodraft` (the time format and zone fixed 6/08).

6. **Upcoming, past, finished, needs-staff and "nearest shift" are decided by the end instant, from one definition.** Any predicate or ordering on shifts must use `shiftNotFinishedSql`/`shiftFinishedSql` (never `event_date >= today`, never a calendar-day comparison, never an assumed "ends next morning"), and any on events must use `eventEndInstant`; the end instant must read the same duration column the edit surfaces write (`shifts.event_duration_hours` when a shift overrides the proposal). Two consumers that claim to mirror each other must import the one fragment; a comment asserting sameness is a finding until the import is there.
   Trigger: a new WHERE or ORDER BY on `shifts`/`proposals` involving `event_date` and a day; a new helper named `*upcoming*`, `*nearest*`, `*next*`, `*needsStaff*`; any edit to `shiftEndInstant.js`, `findNearestApprovedShift`, or a route that buckets shifts.
   Lens: NEW: business-time.
   Defects: D2309, D2313, D2316, D2352, D2356, D2358, D2359 (7).
   Docs to read: `project-staffing-roster-waitlist` (`position` is the money seam a wrongly re-opened shift breaks).

7. **Hour windows are evaluated in a named zone, wrap midnight, and say what happens at the edge.** Every quiet window, jitter window, call clamp, night greeting and the 2:00 AM service curfew must (a) read the hour with `chicagoHourNow` or an explicit `timeZone`, (b) treat `start > end` as a wrap with a test at both edges, (c) state the outcome when a delay or a duration crosses the boundary (fire now, defer to the window's next open, or refuse the booking), never a terminal skip row, and (d) apply on every path that can place the call or extend the service, including bypass, backlog and mid-event paths.
   Trigger: the diff compares an hour to a constant, reads a `*_HOUR`/`*_WINDOW` env var, adds a `setTimeout` or delay before a call, or changes `event_duration_hours` outside `serviceCurfew.js`.
   Lens: NEW: business-time.
   Defects: D2307, D2318, D2319, D2320, D2341, D2351 (6).
   Docs to read: `project-service-extension` (never hand-move a duration), `project-lead-call-bridge`.

8. **Never compare a timestamp read through node-pg back against its stored column.** node-pg truncates a TIMESTAMPTZ to milliseconds and Postgres keeps microseconds, so an equality, an anti-join, or a UNIQUE keyed on a round-tripped `sent_at`/`scheduled_at`/`presence_since` matches nothing. Keep the comparison inside SQL (same statement, a CTE, or compare `::text` against the `::text` you read), or truncate both sides with `date_trunc('milliseconds', ...)`.
   Trigger: the diff passes a `Date` taken from a prior query result or a `RETURNING` clause back into a `WHERE col = $n`, `NOT EXISTS (... = $n)`, or an `ON CONFLICT` whose key includes a timestamp.
   Lens: database-review (query analysis), cross-listed in business-time.
   Defects: D2304, D2334, D2348 (3; the class recurred in three files in three months and each cost a round of failing tests or a dead release path).
   Docs to read: none.

9. **A threshold in days has a unit; a window has edges; check every consumer when either changes.** `daysOut`, `daysUntil` and reconcile windows are either whole Chicago calendar days (`wholeDaysBetween`) or clock days (ms / 86400000, floored or rounded), and a `< 7` or a 14-day branch flips at the edge when the unit changes. On any edit to such a helper, grep every call site and re-derive each threshold's edge; on any new window, write the bounds as a half-open interval and check that the event the window exists for (a payday after `end_date`, a tip after 00:00 on the `to` day) is inside it.
   Trigger: the diff edits `wholeDaysBetween`, `daysBetween`, `daysOut`, a `/ 86400000`, a `BETWEEN` on dates, or any `< N`/`<= N` where N is a day count.
   Lens: NEW: business-time (the consumer-sweep half is consistency-check's method).
   Defects: D2295, D2305, D2324, D2349, D2355 (5).
   Docs to read: the cancel policy's 14-day line (`docs/ops-runbook.md`) for D2305.

10. **No new copies of a time helper; a change to one copy is a rule change.** `toYmd`, `toCalendarYmd`, `ymd10`, `fmtDate`, `daysBetween`, a "today" constant, a reminder anchor: if `businessTime.js`, `chicagoDay.js`, `format.js` or `payrollPeriods.js` already exports it, a local re-implementation is a finding, and a diff that changes one copy must change or delete every other copy. Grep the helper name across `server/` and `client/src` before approving; a comment claiming two copies mirror each other is checked by diffing them.
    Trigger: the diff defines a function or const whose name matches `/ymd|Ymd|toCalendar|fmtDate|daysBetween|today|anchor/` or edits one that has siblings.
    Lens: consistency-check.
    Defects: D2268, D2293, D2316, D2349 (4).
    Docs to read: none.

11. **A day-boundary fix is proven by an evening-instant test through the injection seam, under both zones.** Any change that claims to fix or guard a day boundary must ship a test that sets the day through the file's `_deps.today` seam (or an injected `now`) to a Chicago evening instant on which the UTC and Chicago days differ, mounts the real router or runs the real function (never a copy of the SQL), and passes under both `TZ=UTC` and `TZ=America/Chicago`. A suite that reads the live clock is not evidence; a source regex that matches a comment is not evidence; "accepted as perception-only" is not a verdict.
    Trigger: the diff touches any file in checks 1 to 9's trigger set, or a commit message or sweep note says a time bug is fixed.
    Lens: NEW: business-time (this is the lens's verification rule; code-review would otherwise accept a green suite).
    Defects: D2283, D2285, D2293, D2316, D2326, D2330 (6; each was declared fixed, accepted, or mirrored while still wrong).
    Docs to read: `reference-pay-period-boundary-current-date` (the worked example of the seam and the regex trap).

12. **"Which pay period is now" is a DATE lookup on the Chicago day, and the period row may not exist yet.** Every period pick must take `chicagoTodayYmd()` (or `payPeriodForDate(chicagoTodayYmd())`) as a bound parameter, never SQL `CURRENT_DATE` or a UTC today; and because `pay_periods` rows are minted lazily by accrual, any writer that needs the current period (a bounty line, a late tip, a clawback) must handle the missing row by minting it or deferring with a retry marker that a scheduler drains, never by returning null into silent success. Read the catch-up path: it must run when a period opens, not only on the next human action.
    Trigger: the diff contains `pay_periods`, `payPeriodForDate`, `BETWEEN pp.start_date AND pp.end_date`, or writes a `payout_*` line.
    Lens: NEW: business-time (money; the full fleet applies on these paths anyway).
    Defects: D2315, D2336, D2344, D2345 (4; D2315 reached prod, D2336 is $20 owed and open).
    Docs to read: `reference-pay-period-boundary-current-date`, `reference-payroll-completion-gate` (the second gate: a closed period accrues nothing), `reference-duty-pay-effective-date`.

Not anticipable: D2280 (a date rail that omits the year reads out of order only when a 2027 event exists; a display-design choice, not a mechanism); D2317 (a helper called with a literal `null` second argument fell through to its default; a generic dead-argument check, not a time rule); D2342 (a granularity parameter accepted by the route and ignored by four `date_trunc('month')` sites; a generic unused-filter-parameter check in code-review would catch it, and the one-point chart that hid it is a dataviz concern).

---

## Class: data-import (40 defects)

What keeps going wrong: an import or backfill is written against the author's model of the source and the target, and the model is wrong in one of five ways. The source concept maps onto the wrong target concept (Check Cherry's bundled bar became a $50 line on 14 snapshots, "one additional bartender" became an add-on with the event hours as its count, a guest range took its low end, a keyword anywhere in a lead added a bar rental). The script's re-run contract is never stated, so a second run leaves rows the input no longer claims, retries a past event as live, or forces a flag an admin turned off. The backfill's population is defined by what the author could see (logged transitions, the analysis snapshot, rows that exist today) rather than by what the new code will read, so 29 proposals fell out of the win-rate denominator and legacy rows carry no supply-run flag. Readers written for the new shape meet legacy rows (an object-shaped roster, a bare phone, a title-prefixed name, a missing progress row) and miscount or hide them. And identity is resolved on a key that is not stable (row order, email only, a null that compares equal to zero), so two people's ledgers swapped and the verifier, reading the same sheet, agreed. Twenty-two of the forty are money, and the verifier was self-referential in every one of the ledger cases.

### Checks

1. **Every mapped field the pricing engine or a validator reads is proven by running the target's own recompute on an imported row and diffing it against the source document.** `num_bars`, add-on quantities, `guest_count`, venue state, payroll method, `eligible_item_ids`: for each, show the source value, the stored value, and what `pricingEngine` / `validateVenue` / `buildCatalogSlices` does with it on a transferred row after an admin save. A hardcoded default (`numBars: 1`), a heuristic (low end of a range, a keyword anywhere, unknown maps to `'other'`), or a reference by name must be justified by the source's semantics, and any referenced catalog row must be active in prod.
   Trigger: the diff writes to `proposals`, `proposal_addons`, `proposal_snapshots`/`snapshot`, `service_packages`, `drink_plans`, `contractor_profiles.payroll_method`, or a venue column from a script, a webhook mapper (`thumbtackProposalDraft.js`, `routes/thumbtack.js`), or a CSV.
   Lens: NEW: import-backfill.
   Defects: D0763, D0764, D0779, D0791, D0793, D0815, D0816, D0817 (8).
   Docs to read: yes. `feedback_hosted_bartender_rule` (1:100 included), `reference-addon-quantity-column` (invert only via `storedToInputCount`), `project-thumbtack-autodraft` (`num_bars=0` trap), and the snapshot-recompute rule: an imported snapshot must survive every later recompute, so a bundled bar means `num_bars=0`, not a stripped line (D0764 is still open for this reason).

2. **An import, repair or backfill declares its re-run contract and the reviewer traces all four legs.** (a) Rows written by a prior run that this input no longer claims (verdict flipped to ignore, sheet row removed) are retracted, not left: an insert-or-update-only upsert is a finding on any ledger. (b) A retry of an errored or skipped row re-enters at the row's original bucket or phase and re-runs every later phase (comms enrollment), never "promote as live" by default. (c) `ON CONFLICT DO UPDATE` never overwrites an admin-set value: `COALESCE(existing, EXCLUDED)` for fill-ins, and a boolean flag is never forced. (d) The post-commit side-effect set (audit log, payroll re-accrue, reminders) is computed from the rows this run touched, never from the target's live state after a reassignment.
   Trigger: the diff adds or edits a file under `server/scripts/`, `scripts/`, `server/routes/admin/ccImport/`, a `DO $$` block in `schema.sql`, or any statement with `ON CONFLICT` or the words `retry`, `re-run`, `promote`, `backfill`.
   Lens: NEW: import-backfill (clause c is also database-review).
   Defects: D0776, D0785, D0786, D0794, D0805 (5).
   Docs to read: yes for D0805 and D0785: a ledger row is a 1099 fact (`project-staff-payment-import`, read the file first) and a re-accrue loop touches frozen pay periods (`reference-payroll-line-removal-frozen-period`).

3. **A backfill's population is stated in three parts and each is queried on prod-shaped data: what the new code will READ, what the backfill WRITES, and the gap.** Enumerate every consumer that assumes the new column or shape (an INNER JOIN, a `COUNT`, the Money Board's denominator, a client-facing `includes` column no route can write) and run the backfill's predicate against the rows those consumers will see; the gap must be zero or accepted with its count written down. A backfill sourced from a log or transition table must be cross-checked against rows whose state implies the fact (`status IN ('viewed','booked')` implies sent). A population computed at analysis time is recomputed at execute time with a count assertion before anything destructive runs. "Forward-only" is a finding unless the old rows are shown unreachable by the new code. The source export's filter (which statuses it includes) is compared to the source system's full status list.
   Trigger: the diff adds a column with a default-as-backfill, an `UPDATE ... WHERE ... IS NULL`, a `DO $$` guard, a keep-set or delete list, a "pre-existing rows" comment, or a script named `backfill*`/`apply*`/`scrub*`.
   Lens: NEW: import-backfill (the consumer sweep is consistency-check's method applied to data).
   Defects: D0765, D0768, D0769, D0784, D0792, D0795, D0811, D0819 (8).
   Docs to read: yes for D0795 and D0819 (`reference-proposals-money-and-status`; a paid booking is never in a scrub's delete set).

4. **A reader of a column whose shape has versions either tolerates every live version or follows a backfill that converted them; run it against a legacy row.** Roster arrays versus objects, phones with and without `+1`, times in three dialects, names with a legal title, accounts that predate a seeded row: grep the reader for the new shape's assumption (`Array.isArray`, `jsonb_array_length`, an INNER JOIN on the seeded table, a regex on the new format, a validator that grandfathers "unchanged" values) and execute it on the oldest matching prod row. A grandfather clause in a validator is a finding when a backfill was supposed to have removed the thing it grandfathers.
   Trigger: the diff reads a JSONB column, joins a table that was seeded after some users existed, normalizes a phone or a name, or maps an enum with a catch-all branch.
   Lens: NEW: import-backfill (could live in code-review as a null-and-legacy check, but no lens runs code against old rows today).
   Defects: D0766, D0789, D0790, D0813, D0822 (5).
   Docs to read: `project-display-name-and-seniority` for D0813; `reference-sms-phone-routing` for D0822 (last-10-digit is the live match).

5. **Every identity key an import or a dedup uses is stable, normalized like the live lookup, two-sided, and a bijection.** Stable: never row order, never a placeholder that depends on sort. Normalized: lower email, last-10-digit phone (`clientDedup.js`, `lookupSender`), all-digit user ids, the same role vocabulary the roster uses. Two-sided: a match is confirmed by a second field or an operator, and a non-match is checked for a near miss (phone plus name with no email); a null in a match predicate fails the match (`Math.abs(null) === 0` is a vacuous pass, and the tier that never matches is a dead tier). Bijection: the verifier asserts no target is claimed by two sources and no source is split across two targets, with a warning on any reused claimed account.
   Trigger: the diff edits `clientDedup.js`, `importValidation.js`, `eventMatch.js`, `exportKnownPeople.js`, a `findOrCreate*`, a `normalizePhone*`, or any script that assigns a `user_id`/`client_id`/`contractor_id` from external data.
   Lens: NEW: import-backfill (D0771 is a webhook path, so security-review's IDOR eye also applies; keep both).
   Defects: D0771, D0800, D0801, D0804, D0806, D0807, D0808, D0822 (8).
   Docs to read: yes for the ledger ones: a swapped identity swaps a whole 1099 (`project-staff-payment-import`).

6. **Dates from an external source are normalized to `YYYY-MM-DD` by one parser with its locale stated, at load, and a date that moves in the harmful direction is refused by the applier, not only flagged by the generator.** Check Cherry is `MM-DD-YYYY`; a raw value must never reach a DATE insert (DateStyle-dependent) or a string comparison (year grouping). A hire date can only move earlier unless an operator flags otherwise; that protection lives in `applySeniorityBackfill.js`'s write path, because a hand-built CSV with an empty `flags` column bypasses anything that lives only in `generateSeniorityMapping.js`.
   Trigger: the diff parses a date from a CSV, a sheet, a webhook payload, or a PDF text; or writes `hire_date`, `paid_on`, `event_date` from a script.
   Lens: NEW: import-backfill (cross-listed in business-time check 5).
   Defects: D0780, D0799, D0803 (3, plus D2322 from the time class; D0799 corrupts 1099 year grouping and D0803 demotes a person in every auto-assign pick).
   Docs to read: `project-staff-payment-import` (read the file first), `project-display-name-and-seniority`.

7. **A post-import verifier compares against a source the import did not read, and asserts the negative space.** A verify that re-derives expected rows from the same sheet the import consumed will confirm a swap, a reused account and a stale row equally well; it must also check the prior run's log for rows this input no longer claims, per-person-per-year totals against the source export, that every claimed target is claimed once, and that a renamed profile is a rename and not a different person (demote to a warning, never a silent pass). A green `verifyImport` is reported with what it compared against, or it is not evidence.
   Trigger: the diff edits `verifyImport.js`, any `verify*`/`check*` script, or marks an import executed.
   Lens: NEW: import-backfill (this is the lens's verification rule, the twin of business-time check 11).
   Defects: D0805, D0806, D0808, D0810 (4; every one is a 1099 figure).
   Docs to read: `feedback-verify-behavior-not-shape`.

8. **A repair that reconstructs money lines matches on provenance, never on the row's current state.** Match an invoice line to the adjustment, payment, or frozen snapshot that created it at the time (`created_at`, the Stripe object, the snapshot), not to the proposal's current adjustments; compute the keep-set or the affected-proposal set from the rows and the moment the repair is about, not from the live approved set after a reassignment or an analysis taken days earlier. A line with no provenance is listed for hand review, never re-labeled as a charge on a paid receipt.
   Trigger: the diff is a one-off repair SQL or script touching `invoice_line_items`, `invoices`, `proposal_payments`, `payouts`, or a delete list.
   Lens: NEW: import-backfill (money; the full fleet applies).
   Defects: D0770, D0785, D0795 (3; D0770 is an open wrong receipt on a paid invoice).
   Docs to read: yes. `project-invoice-derivation-batch` (redo provenance-first), `reference-off-ledger-invoices` (labels must join `OFF_LEDGER_INVOICE_LABELS`), `reference-acknowledged-total-is-row-truth`.

Not anticipable: D0762 (a one-time blog import's heading heuristic; caught only by reading each post against its source, which is editorial review, not a check); D0797 (the seeded Margarita build is a recipe fact only the owner holds; the package fence it tripped is check 1's territory only once the fact is known).

---

## Summary

time-date: 12 checks (10 in NEW: business-time, 1 in database-review, 1 in consistency-check); 3 not anticipable.
data-import: 8 checks (all NEW: import-backfill, with cross-listings to database-review, security-review and business-time); 2 not anticipable.
NEW lenses: business-time, import-backfill.
