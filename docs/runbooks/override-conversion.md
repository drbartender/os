# Override conversion runbook (step 2)

Converts every `total_price_override` into a hidden "Agreed price adjustment" line, and backfills a "Refund" line for contract refunds that never got one, without moving any total. Spec: `docs/superpowers/specs/2026-10-16-price-override-removal-design.md` section 8. Plan: `docs/superpowers/plans/2026-10-16-price-override-removal.md`, lane conversion-tooling (Tasks V1 to V4). Tooling: `scripts/override-conversion/`.

It runs once, on prod, by hand, after push 1 is live and before push 2 (which deletes the override code). Nothing in this runbook runs without Dallas's go on the dry run.

## Rules that never bend

- **The data never passes through a chat or an MCP result.** The export, the fresh compute, the report and both blocks live only in the session scratchpad (chmod 600). They carry free-text labels and the repo is public: never commit them, never paste them. The one exception is step 6, where the forward block itself goes through Neon MCP `run_sql` (compact: ids, md5s and the new lines, plus the full snapshot of the live bookings only).
- **Never the push gate's branch.** Every branch here is cut by `branch.js` and named `override-conversion-<YYYYMMDD-HHMM>`; `branch.js --delete` refuses anything else (ci-smoke, production, dev, any default or protected branch).
- **Never while a push is running.** A push in progress freezes main and the gate resets its own branch; wait for it.
- **Legal hold is refused by construction.** The export asks for candidate ids first and the legal-hold seam (`server/utils/legalHold.js`, which reads `LEGAL_HOLD_PROPOSAL_IDS`) drops held ids before any row is read; the fresh compute, the transform, the renderer and the confirmation each refuse a held id again. A held booking is never exported, priced, written, reported or named. Do not pass a held id anywhere by hand.
- **No `updated_at` anywhere.** Every guard is the md5 of the money columns (`total_price`, `amount_paid`, `status`, `total_price_override`, `adjustments`, `pricing_snapshot`); a client page view moves `updated_at` and must not stop the run.

## The tools

| Script | What it does |
|---|---|
| `branch.js --scratch <dir> [--parent <id>]` | Cuts a branch (default parent: production) with a read_write endpoint, waits until it answers, writes its URI to `<dir>/<name>.uri` (chmod 600), prints the branch id. A failure after the branch exists deletes it and says so; if that cleanup fails too, the message prints the `--delete` command to run by hand. `--delete <id> [--scratch <dir>]` removes a conversion branch and its URI file. Key: `NEON_API_KEY` or `~/.secrets/neon_api_key`. |
| `export.js <uri-file> <out.json> [--expect-overrides <census-file>]` | With `--expect-overrides`, any override id outside the census stops the run (exit 3, nothing written). One read-only REPEATABLE READ snapshot of the branch: every override booking and every booking with a succeeded contract refund, with their succeeded refunds, add-on rows, Additional Services invoices and pending change requests, and each row's money md5. |
| `freshCompute.js <uri-file> <export.json> <out.json>` | Prices each live override booking at today's catalog (`computeCatalogSnapshot`, the fold's own builder) in a child bound to the branch, inside a rollback, loading each row whole. A row it refuses is recorded and listed, never fatal. |
| `run.js <export.json> <fresh.json> <out-dir> [--compare <changes.json>]` | The transform: writes `changes.json`, `report.txt`, `forward.sql`, `reverse.sql` into a NEW out-dir (it refuses a non-empty one). `--compare` checks a re-run against an earlier change set (only the fresh compute's timestamp may differ), is read before anything is written, and must sit outside the out-dir; exit 2 when it differs. |
| `reverse.js <changes.json> <out.sql> (--except <ids> \| --only <ids>)` | A reverse block for part of a run, under the run's own tag (see Rollback). |
| `confirm.js <uri-file> <changes.json>` | The read-only confirmation (step 7), including a key-by-key compare of every written row with the change set. Exit 0 only when clean. |
| `applyBlock.js <uri-file> <block.sql>` | Runs a rendered block over pg against a conversion branch. Rehearsal only; prod's block goes through MCP. |
| `rehearsal-seed.js <uri-file>` | Seeds one synthetic booking of every shape on a conversion branch (dev rehearsal only). |

`export.js`, `freshCompute.js`, `run.js` and `confirm.js` take `--also-held <id,...>`, which only ever ADDS ids to the legal-hold refusal (the rehearsal's synthetic hold). The real run never passes it. Every tool that connects takes only a URI file `branch.js` wrote (its name starts `override-conversion-`).

## Steps

In every command, `S` is the session scratchpad (for example `S=/tmp/claude-1000/<project>/<session>/scratchpad/conv`) and the working directory is the `os` checkout on main with the conversion tooling merged.

1. **Preconditions.** No push is running, and push 1 is live (the staleness guard, the legal-hold guards and the refund line writer are all in prod). `scripts/cc-transfer-events.js` has not been run since push 1, so no override was written after the census: after step 2, the export must hold exactly the census's non-held override bookings, 37 rows (4 live: 606, 607, 608, 756; 33 terminal: 23 archived, 10 completed). Record the census's 37 non-held override ids (ids only, from the 2026-10-16 census read) in `$S/census.txt`; step 2's export checks against it and stops (exit 3, nothing written) on any other override id. Any other count, or a live override outside those four, also goes back to Dallas.
2. **Cut, export, compute, render.**
   ```
   node scripts/override-conversion/branch.js --scratch $S
   node scripts/override-conversion/export.js $S/<branch-name>.uri $S/export.json --expect-overrides $S/census.txt
   node scripts/override-conversion/freshCompute.js $S/<branch-name>.uri $S/export.json $S/fresh.json
   node scripts/override-conversion/run.js $S/export.json $S/fresh.json $S/run1
   ```
   Read the counts the scripts print (ids and counts only). `run1/report.txt` is the dry run.
3. **Review the rendered SQL.** Dispatch `database-review` and `consistency-check` on `run1/forward.sql` and `run1/reverse.sql` against `run1/changes.json` and this tooling, reading the files in place. Any finding is fixed in the tooling (a lane) and the run restarts at step 2.
4. **Dallas reads the dry run.** He reads `run1/report.txt`: per booking the line or lines, the catalog drift (live rows: today's catalog against the stored price), the page and invoice fold verdicts (`package` folds into the package row; `fallback` shows one "Pricing adjustment" row) and pending change requests. Then his lists: row and snapshot lines that differ (left unchanged), refunds with no line and no gap (likely billed again by an editor save; the Additional Services invoices minted after each refund are listed), gaps not equal to the unlined refunds, and anything not converted (with the reason). He settles the pending change requests on the live bookings (spec 5.2) before step 6.
5. **Immediately before running, re-derive,** into a NEW directory, comparing with `run1` (what Dallas approved):
   ```
   node scripts/override-conversion/branch.js --scratch $S
   node scripts/override-conversion/export.js $S/<new-branch-name>.uri $S/export2.json --expect-overrides $S/census.txt
   node scripts/override-conversion/freshCompute.js $S/<new-branch-name>.uri $S/export2.json $S/fresh2.json
   node scripts/override-conversion/run.js $S/export2.json $S/fresh2.json $S/run2 --compare $S/run1/changes.json
   ```
   `run.js` refuses a `--compare` inside its own out-dir and a non-empty out-dir, so `run1` is never overwritten and never compared with itself. Identical (exit 0): proceed under Dallas's go. Different (exit 2, the differing ids printed): back to him with `run2/report.txt`. Keep this branch: it is the point-in-time rollback copy. Delete the step 2 branch (`branch.js --delete <id> --scratch $S`). From here until step 6 has run, no package or add-on price edits: the md5 guard covers each booking's own columns, not the catalog a live row's line was priced against.
6. **Run the forward block** through Neon MCP `run_sql` on the production branch (`br-noisy-frog-ad99sa6l`), pasting `run2/forward.sql` exactly as rendered. It is all or nothing: any RAISE (a row that moved since the export, a write that touched other than one row, a row that does not add up from its own JSON) aborts the whole block and writes nothing; read the message (ids and the run tag only) and go back to step 5. The block's own checks prove ids, md5s, amounts and totals; they cannot see a slip in a label, `visible`, `source` or `refund_id`, or in a breakdown row, so step 7 compares every written row with `run2/changes.json` key by key.
7. **Confirm.** Cut a NEW branch (it now carries the converted state) and run:
   ```
   node scripts/override-conversion/confirm.js $S/<new-branch>.uri $S/run2/changes.json
   ```
   Clean means: every written row holds exactly what `run2/changes.json` says, every key of its lines and snapshot (a content mismatch means a paste slip: run the reverse and start over at step 5); no booking carries an override outside the legal-hold list (a converted one still overridden, one still on Dallas's list, or a new one all fail it; held bookings are counted, never named); every changed row's snapshot total equals `total_price`; every contract refund with a drop has its line, sits on an override-absorbed booking (527, 599), or is on Dallas's list; every changed row has its activity record. Delete that branch afterwards. Push 2 (override-removal) waits until this is clean. A booking on Dallas's lists keeps it NOT clean until he settles it (his call per booking); then steps 2 to 7 run again, and the second run converts only what is left, because converted rows are no longer candidates and backfilled refunds carry their lines.
8. **Fix list.** Close the refund entry ("a contract refund on a booking with no override is billed again by the next editor save") for every booking the backfill wrote; keep Dallas's listed bookings open there with their ids.
9. **Keep the step 5 branch until Dallas confirms the result**, then `branch.js --delete <id> --scratch $S`.

### Rollback

The reverse is valid only until push 2 ships. After push 2 the engine no longer reads `total_price_override`, so restoring an override would let the next re-price (a drink-plan submit needs no admin confirm) drop the agreed-price line and move `total_price` (606 by $162). After push 2, never run a reverse: settle by hand under Dallas's review.

`run2/reverse.sql` through MCP `run_sql` on the production branch restores every converted row's money columns from the before-state the forward block recorded in that row's `proposal_activity_log` entry, only while the row is still exactly as the forward block left it (its after-state md5), and proves each restore reproduces the exported md5. It is all or nothing: one row that moved since the conversion (an editor save, a payment) makes it refuse and restore NOTHING. Then render a reverse for the rest under the run's own tag and run it the same way:
```
node scripts/override-conversion/reverse.js $S/run2/changes.json $S/reverse-rest.sql --except <moved ids>
```
Only the moved rows are settled by hand, under Dallas's review. Each one's before-state is in its activity row (`details.before`), so no prod snapshot has to pass through the chat.

### What the activity log shows

Each converted row gets one `proposal_activity_log` row, actor `system`: `price_override_converted` or `refund_line_backfilled`, with `details.run` (the run tag), `details.lines`, `details.before_md5`, `details.after_md5` and `details.before` (the money columns the reverse block restores). A reversal adds `override_conversion_reversed`.

## Rehearsal on dev, 2026-10-17

Run by the conversion-tooling lane, no prod access of any kind. Two branches of dev (`br-delicate-union-adt2hvor`), both deleted at the end: `br-dark-wildflower-adgj6jto` (the DO block suite ran on it twice) and `br-fragrant-frost-adrj6kkf` (the pipeline below).

- Seeded one synthetic booking of each of 17 shapes (`rehearsal-seed.js`), the synthetic hold passed as `--also-held`. The branch also carried dev's own 19 override bookings (18 live, 1 completed).
- `export.js`: 35 bookings (20 live override, 9 terminal override, 6 refund only); the held booking was not read.
- `freshCompute.js`: 20 live bookings priced, 0 refused.
- `run.js`: 30 changes (20 live, 8 terminal, 2 refund backfill); for Dallas: 1 lines differ, 1 refund gap 0, 1 refund gap unequal, 0 not converted. Forward block 41 KB (20 full live snapshots), reverse 5 KB.
- Step 5 rehearsed: a second export and fresh compute on the same branch compared identical (`--compare`, exit 0) although its run tag differed (the compute timestamps).
- Forward block applied over pg. Applying it again was refused (`changed since the export`).
- `confirm.js`: 30 changed rows checked, 1 held booking counted and not named, 2 unlined refunds on Dallas's list; NOT clean for exactly one reason, the synthetic row whose lines differ (it keeps its override on Dallas's list), as designed.
- Reverse block applied; a fresh export then matched the original money md5 on 35 of 35 rows (an exact restore), and the change set compared identical.
- The held id appeared in none of the export, change set, report or blocks.
- Fix round (2026-10-17): the DO block suite now cuts its own branch of dev and deletes it in its teardown (it never runs a block on the shared dev DB or on DATABASE_URL); its runs created and deleted `br-withered-feather-ad1hrwjp`, `br-bitter-hill-ad1tbku2`, `br-young-credit-ads19wg0` and `br-super-waterfall-ad8rm7r6`, all deleted. A short re-rehearsal of the fixed CLIs on `br-billowing-cake-advgwsbs` (deleted) showed: a census missing one id stops the export (exit 3, nothing written); a second run into a used directory is refused; after one converted row moved, the full reverse refused and `reverse.js --except` restored the other 31 of 32 rows, each to its exported md5.
