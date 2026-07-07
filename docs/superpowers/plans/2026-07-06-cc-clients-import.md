# CC clients import (lean reboot) — plan + runbook, 2026-07-06

The cc-import v2 spec (2026-05-30) is RETIRED. Dallas's call: fresh final
CheckCherry exports, start over, drastically smaller. Scope of this lane is
CLIENTS ONLY: no proposals, no events, no payments, no comms, and none of the
v1 phase machinery. Design was conversational (session 2026-07-06); the
authoritative behavior spec is the header comment in
`scripts/cc-clients-import.js`.

## What ships

- `scripts/cc-clients-import.js` + unit tests: one-time operator script,
  dry-run by default, `--apply` to write. Import rule: CC Customer contacts
  who paid > $0 OR appear on a Confirmed event. That is 187 of 1,175 contacts
  in the 2026-07-06 exports; quoted-but-never-booked contacts stay in the raw
  archive (`~/cc-archive/2026-07-06/`, copies also on the Windows share).
- Clients land as name / email / phone / `source='checkcherry'` / `cc_id` /
  one neutral history digest in notes (count, last event, up to 3 venues,
  lifetime paid). No vendor branding in prose, per Dallas.
- Merge rule for emails already in prod (3 as of 2026-07-06): fill blanks
  only, append digest to notes, set cc_id; native name/source/phone/notes are
  never overwritten. `cc_id IS NOT NULL` means skip, so re-runs are no-ops.
- `schema.sql`: 'checkcherry' added to the clients.source CHECK. The cal.com
  block stays the SINGLE live definition of that constraint (lane review
  caught that a second drop-and-re-add block would make the earlier block's
  VALIDATE fail on every boot once imported rows exist).

## Verification done

- 14 unit tests green (parsing, import rule, digest, guards).
- Rehearsed on a Neon branch of production (`cc-clients-rehearsal`, expires
  2026-07-08): dry-run 184 insert / 3 merge / 0 skip, `--apply` verified
  (natives untouched, merges correct), re-run dry-run showed 187 skips
  (idempotency), amended constraint block replayed clean with checkcherry
  rows present.
- Lane review: 1 focused DB/correctness agent; BLOCKER + 2 MEDIUM + 2 NIT all
  fixed except the merge-UPDATE unit test (covered by the prod-copy rehearsal;
  accepted).

## Prod runbook (after this lane is pushed/deployed)

1. Deploy first: initDb replays schema.sql and extends the CHECK constraint.
2. `DATABASE_URL=<prod> node scripts/cc-clients-import.js --contacts <report (5).csv> --events <report.csv>` (dry run; expect 184/3/0 and the two orphan-email warnings).
3. Same command with `--apply`, on Dallas's explicit go.
4. Eyeball a couple of imported clients + one merged one (Stef D., Tabitha Lopez, Hillarie Rovi) in the admin.

## Out of scope, tracked for later phases

- Master CC report sidecar load (payments/payouts/event summaries into the
  existing empty `legacy_cc_*` tables) + blended financials/dashboard.
- The 14 future confirmed CC events: Dallas enters them manually once clients
  are in (balances must reflect CC-collected deposits WITHOUT native payment
  rows). CC access ends ~1 month out; contracts download still owed.
- Dev DB carries all 1,215 v1-imported contacts (prod never did); scrub is
  future housekeeping. v1 cc-import code deletion is also future housekeeping.
