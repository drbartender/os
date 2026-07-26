# Seniority history backfill: hire dates and pre-migration event counts from CheckCherry

Design spec, 2026-07-26. Approved section by section in conversation.

## 1. Problem

Staff seniority drives who the auto-assign ranker offers a shift to, and it is
shown on the admin seniority panel. Both compute the same score:

```
score = events_worked × 0.7  +  tenure_months × 0.3  +  seniority_adjustment
```

Two of those inputs do not reflect reality for staff who came over from
CheckCherry:

- **`events_worked` is live-computed from OS shifts only.** It counts a person's
  approved, non-dropped, past-dated `shift_requests` inside this system
  (`autoAssign.js` step 3; `admin/users.js` GET `/users/:id/seniority`). Every
  event these people worked in CheckCherry before the migration — Kaitlyn's 32,
  Shea's 13, Chima's 11 — is invisible to the score. There is nowhere to put it.
- **`hire_date` reflects OS onboarding, not the true start.** Migrated staff got
  a hire_date when they were entered into the OS system, which is later than when
  they actually started with the company.

We have the CheckCherry contacts export (`~/win-share/payments/cc-report-contacts.csv`),
which carries, per contact: name, phone, `Created At` (their original add date in
CheckCherry), and `Staff Events: Count` (events worked as staff). Forty contacts
are staff-flagged. We want migrated **active** staff to carry their true hire date
and a pre-migration event credit, so seniority reflects real tenure and real
experience.

The CheckCherry numbers are taken at face value: if a person worked 20 events,
that is 20 events. The date is the hire date, full stop — its provenance is not
re-litigated.

## 2. How seniority works today (ground truth)

- `contractor_profiles.hire_date DATE` — feeds `tenure_months`. Editable via
  `PUT /users/:id/seniority` and the admin seniority panel.
- `contractor_profiles.seniority_adjustment INTEGER DEFAULT 0` — a manual additive
  knob. **Untouched by this work**; it stays a separate lever.
- `events_worked` — **not stored.** Live `COUNT` of `shift_requests` joined to
  `shifts` where `status='approved' AND dropped_at IS NULL AND event_date < CURRENT_DATE`.
  Computed in two places:
  - `server/utils/autoAssign.js` — step 3 (the `GROUP BY user_id` count into
    `eventsMap`) feeding step 5's scoring.
  - `server/routes/admin/users.js` — GET `/users/:id/seniority` (`eventsRes`).
- Staff status lives in `users.onboarding_status`, enum
  `in_progress | applied | interviewing | hired | rejected | submitted | reviewed | approved | suspended | deactivated`.
  A real working staffer is `approved` or `hired`.

## 3. The change

### 3.1 New column

```sql
ALTER TABLE contractor_profiles
  ADD COLUMN IF NOT EXISTS historical_events_worked INTEGER NOT NULL DEFAULT 0;
```

The count of events a person worked **before** the OS migration (i.e. in
CheckCherry). Default 0 means every non-migrated profile is a no-op. It sits
alongside `hire_date` and `seniority_adjustment` as a first-class seniority input.

### 3.2 events_worked = live + baseline, everywhere it is computed

`events_worked` stays live-computed, but every site that computes it adds the
baseline:

```
events_worked = live_OS_count + historical_events_worked
```

- **`autoAssign.js`** — add `historical_events_worked` to the step-2 candidate
  profile SELECT, and in step 5 use `(eventsMap[user_id] || 0) + (candidate.historical_events_worked || 0)`
  when calling `computeSeniorityScore`. The pure `computeSeniorityScore` function
  and its math are unchanged — it already takes a final events number.
- **`admin/users.js` GET seniority** — add the column to the profile SELECT and
  set `eventsWorked = liveCount + historical_events_worked`.

The plan step **greps for every reader of the live events count** and updates each
one, so the ranker and every displayed number always agree (cross-cutting
consistency). If a third site exists, it is in scope.

### 3.3 hire_date set directly from the CheckCherry date

For each approved mapping row, `hire_date` is set to the CheckCherry `Created At`
date, truncated to a DATE (the export value carries a time, e.g.
`02-21-2025 5:52 PM`; only the date is kept). CheckCherry dates are `MM-DD-YYYY`
and normalize through the existing `ccDateToIso` helper. No earliest-wins logic:
the CheckCherry date wins directly. The one guard is a **review-time highlight**
(not code) — see §4.

### 3.4 Admin seniority panel

The seniority panel (`client/src/pages/admin/userDetail/…`) shows the split so the
number is legible — e.g. "3 live + 32 historical = 35 events" — and makes
`historical_events_worked` an **editable field**, so the baseline is maintainable
going forward, not a one-shot seed. The GET response gains `events_worked_live`
and `historical_events_worked` alongside the existing total `events_worked`; the
PUT accepts `historical_events_worked` next to `hire_date` / `seniority_adjustment`
(same `COALESCE`-to-keep pattern).

## 4. The mapping-and-apply flow (the human gate)

Neither value is ever written by blind fuzzy-match. Two steps with a human review
between them.

**Step A — generate the proposed mapping (read-only).** A script cross-references
the CheckCherry contacts CSV against the OS staff (via the existing
`exportKnownPeople` export and the `dictionary.js` alias/cluster resolver, which
already knows `Chip Weinke → Vernon Wienke`, `Katie → Kaitlyn Freyer`, etc.) and
writes a review CSV. One row per CheckCherry staff-flagged contact:

| column | source |
|---|---|
| `cc_name` | CheckCherry |
| `cc_created_date` | CheckCherry `Created At` → DATE |
| `cc_events` | CheckCherry `Staff Events: Count` |
| `matched_user_id` | dictionary resolve → OS user (blank if no match) |
| `os_preferred_name` | OS |
| `onboarding_status` | OS |
| `current_hire_date` | OS |
| `proposed_hire_date` | = `cc_created_date` |
| `current_live_events` | OS live count |
| `proposed_historical` | = `cc_events` |
| `include` | default `yes` when matched AND status in (`approved`,`hired`); else `no` |
| `flags` | `unmatched`, `ambiguous`, `date-moves-later` (proposed hire_date later than current — the rare tenure-shortening case), `zero-events` |

This step touches **no writes** — it only reads the CSV and the DB.

**Step B — Dallas reviews / edits the CSV**, toggling `include` and correcting any
match. This is the safety valve for the unverified source data.

**Step C — apply.** A script consumes the *approved* CSV and, for `include=yes`
rows only, writes `hire_date` and `historical_events_worked` on the matched
profile. Dry-run by default (prints the exact before→after per row and a summary);
`--apply` performs the writes. Idempotent and re-runnable (explicit `SET` to the
approved values, so a second run is a no-op). Mirrors the existing
`exportKnownPeople.js` conventions (dotenv/pool nesting, `--review-dir`).

## 5. Data facts and edge cases

- `Staff Events: Count` is the historical baseline, verbatim. `0` → no-op (column
  stays default 0).
- The owner (Dallas) and admins (Zul) are staff-flagged in CheckCherry but are not
  rankable bartenders; they drop out at the `include` review (and via the
  `approved`/`hired` default filter where applicable).
- Phones are **out of scope** — this work does not touch contact fields.
- `date-moves-later` rows are flagged for the eyeball but still apply the CC date
  if left `include=yes`; there is no automatic override.
- Names not matched to an OS account are surfaced (`unmatched`) and simply not
  written — a CheckCherry-only person with no OS presence is skipped.

## 6. Normalization cap (deliberately unchanged)

Auto-assign normalizes raw seniority against `maxSeniorityRaw = 50`
(`autoAssign.js` step 5). Crediting large histories pushes veterans toward the
100-point ceiling and compresses differences at the very top — correct behavior
for "maxed-out senior," but it means a 32-event and a 50-event veteran may score
nearly the same on the seniority axis. This spec does **not** retune the cap; it
is noted as a known interaction to revisit separately if desired.

## 7. Testing

- **Both compute paths reflect the baseline.** A profile with a non-zero
  `historical_events_worked` scores in the ranker (`autoAssign`) and reports on the
  GET seniority route as live + baseline. A zero baseline changes nothing
  (regression guard).
- **Seed script:** dry-run prints the diff and writes nothing; `--apply` writes
  exactly the approved rows; a second `--apply` run is a no-op (idempotent);
  `include=no` and `unmatched` rows are never written.
- **Run the suites the change reaches** — grep callers of the events-count query
  and the seniority route, run those suites (auto-assign, admin users/seniority).

## 8. Out of scope

- Contact fields (phone, email, address).
- Injecting synthetic `shifts` / `shift_requests` rows for historical events —
  explicitly rejected; it would corrupt payroll, tips, payouts, paystubs, and
  reporting. The baseline column is the whole point.
- Changing the seniority weights (`0.7` / `0.3`) or the normalization cap.
- Any client comms.

## 9. Files touched (indicative; the plan pins them)

- `server/db/schema.sql` — new `historical_events_worked` column (idempotent).
- `server/utils/autoAssign.js` — profile SELECT + step-5 events sum.
- `server/routes/admin/users.js` — GET seniority (live + baseline, split fields),
  PUT seniority (accept baseline).
- `client/src/pages/admin/userDetail/…` — seniority panel: show split, edit baseline.
- `server/scripts/staffPaymentImport/` (or a sibling scripts dir) — generate-mapping
  (read-only) + apply (dry-run/`--apply`) scripts, reusing `ccReports.js` /
  `dictionary.js`.
- Tests alongside the above.
- `README.md` (folder tree, new scripts), `ARCHITECTURE.md` (schema section: new
  column) per the mandatory-docs table.
