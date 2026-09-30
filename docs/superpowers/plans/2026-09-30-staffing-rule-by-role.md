# One Staffing Rule, By Role (lane staffing-rule-by-role) Implementation Plan

**Goal:** Every surface that says whether an event still needs staff counts BY ROLE, the rule the phone list, the phone staffing card, the desktop event page and the ShiftDrawer already use: a slot is filled only by someone approved for that role, an approval in a role the roster never declared fills nothing, an approval with no role takes the first role with room, and a roster that declares no roles is one slot (`neededCount`). Queued by Dallas 2026-09-30 after lane `phone-owner-decisions` moved the phone list onto the rule and its reviews found the rest still counting heads.

**Decision trail:** `docs/fix-list-remaining-2026-07-02.md`, Admin UI, "QUEUED LANE (Dallas, 2026-09-30): one staffing rule everywhere, by ROLE", and the "DECIDED 2026-09-30" bullet for the phone list count. Dallas's word: "start the staffing rule lane".

**Depends on:** lane `phone-owner-decisions` merged to main (it adds `roleFill` and `rowRoleFill` to `client/src/components/adminos/shifts.js`). Cut this lane only after that squash is on main.

**Prod facts (read-only, 2026-09-30, production branch):** 98 shifts; every `positions_needed` is a JSON array of known role strings; 0 NULL, 0 non-array, 0 empty, 0 legacy object-shape, 0 unknown-role, 0 mixed-role rosters; 0 approved-and-active requests with a NULL or unknown `position`; 21 open shifts dated from yesterday on. So on every real row the role rule and the head count give the same answer today, and every edge below is fixture-only. Nothing a person sees changes at deploy.

## What counts heads today (verified against main 2026-09-30)

Server, three copies of one predicate (`approved_count < jsonb_array_length(positions_needed)`, and an empty roster never needs staff):
- `server/routes/shifts.queries.js` `NEEDS_STAFF_SQL` (`:358-362`): the phone list's Needs staff chip, its filter and `needs_staff_events`.
- `server/routes/shifts.js` `GET /shifts/unstaffed-upcoming` WHERE (`:239-243`): the AssignToEventModal list. Sensitive-listed file.
- `server/routes/admin/settings.js` badge-counts `unstaffed_events` (`:143-156`): the tab badges, desktop and phone.
- `server/utils/lastMinuteStaffingConfirmation.js` `confirmStaffingIfFullyStaffed` (`:229-250`): "fully staffed" = approved count >= roster length, and a win CLEARS `last_minute_hold` and sends the client the staffing confirmation (email + SMS). Included because it is the same rule and the one that talks to a client: a mixed-role over-fill would tell the client they are fully staffed with the barback slot open. `autoAssign.js` already counts Bartender slots by role and is untouched.

Client desktop:
- `client/src/pages/admin/EventsDashboard.js` Unstaffed tab filter (`:136-138`) and count (`:167`).
- `client/src/pages/admin/overview/OverviewPage.js` `unstaffed` (`:273-274`), which feeds the header count and the queue.
- `client/src/pages/admin/overview/queueItems.js` `open` (`:56`).
- `client/src/components/adminos/StaffingCell.js` `deriveStaffing` (`:27-31`): the Events list staffing column. Its "No roster" state for an empty roster (`:61-63`) is a designed display and stays.

Already by role, untouched: `EventDetailPage.js` staffing card (`:374-395`), `ShiftDrawer.js`, the phone list, detail and sheet, `autoAssign.js`.

## The rule, stated once

For one shift: roster = `parsePositionsNeeded(positions_needed)` (both historical shapes; unknown roles dropped; malformed or NULL is `[]`). Approved = requests `status = 'approved' AND dropped_at IS NULL`, each read by `canonicalizeRole(position)`: a canonical role is NAMED, anything else (NULL, unknown text) is ROLELESS.
- Roster with roles: `open = max(0, sum over roster roles of max(0, needed_r - named_r) - roleless)`. (Each roleless approval fills one open slot while any remains, which is what `roleFill`'s "first role with room" loop does to the total.)
- Empty roster: one slot, `open = max(0, 1 - all approvals)`.
- Needs staff = open > 0 (plus the existing not-finished and `status = 'open'` terms).

Behaviour change on fixtures only: an empty, NULL or malformed roster with nobody approved now needs staff on the server, as it already did on the desktop Unstaffed tab and the phone card (`neededCount`'s own comment: reading an empty roster as 0 "would make every such shift fully staffed and drop it out of all four surfaces silently"). `confirmStaffingIfFullyStaffed` keeps its early return for an empty roster: it never confirms a shift that declares no roles.

## Tasks

### Task 1: server rule, JS and SQL, pinned to each other
- `server/utils/staffingClassification.js`: add `roleFill(roster, approvedByRole = {}, roleless = 0)` returning `{ slots, open, filled, remaining, approvedByRole }`, the CJS twin of the client's `roleFill` in `client/src/components/adminos/shifts.js` (comment each toward the other; same dual-file pattern as eventTypes.js).
- `server/utils/positionsNeeded.js`: add `canonRoleSql(expr)` (the SQL twin of `canonicalizeRole`: whitespace-trimmed, case-folded, `server` aliases Banquet Server, else NULL) and `openSlotsSql(shiftAlias = 's')`, a scalar subquery giving the shift's open slots by the rule above. Roster elements: a JSON string is one slot of its role; a JSON object is `count` slots of its `position` (a JSON number, or a numeric string, ceiled, floored at 0; `true` is 1; anything else 0); every other element fills nothing. A non-array or NULL column reads as `[]` (keeps the `IS JSON ARRAY` crash guard: `positions_needed` is TEXT and a bare cast raises 22P02). Documented exotic deviations from JS `Number()` (hex strings, exponent strings) are fixture-impossible and stated in the comment.
- Tests: `server/utils/staffingClassification.test.js` gains `roleFill` cases (over-fill, undeclared role, roleless onto room, roleless with no room, empty roster, dropped not counted is the caller's job). A DB test, `server/utils/openSlotsSql.test.js`, seeds a fixture matrix of shifts and requests on the dev DB (flat, object-shape with numeric and string counts, empty, NULL, malformed text, unknown role, mixed over-fill, roleless approvals, a dropped approval, a denied request) and asserts, row by row, that `openSlotsSql` equals `roleFill(parsePositionsNeeded(...), named, roleless).open`. Cleans up its own rows.

### Task 2: the three server predicates use `openSlotsSql`
- `NEEDS_STAFF_SQL`: `COALESCE((<not finished> AND s.status = 'open' AND ${openSlotsSql('s')} > 0), false)`. The `IS JSON ARRAY` and `jsonb_array_length > 0` terms go (the fragment owns both).
- `/shifts/unstaffed-upcoming` WHERE and the badge's `unstaffed_events`: the same `${openSlotsSql('s')} > 0`. The comments that say "change one, change both" now point at one imported fragment.
- Tests: `server/routes/shifts.adminScoped.test.js` (pins the feed and the badge to the same rows) gains the mixed over-fill: flagged `needs_staff`, counted in `needs_staff_events`, in the badge and in `/unstaffed-upcoming`; and an exactly-filled mixed roster is none of those. `shifts.unstaffedJsonbGuard.test.js` and `settings.badgeCounts.test.js` stay green (malformed text still never 500s).

### Task 3: `confirmStaffingIfFullyStaffed` by role
- Read the roster through `parsePositionsNeeded`; return early on an empty roster (unchanged); read the approved rows' `position`s and confirm only when `roleFill(...).open === 0`. The atomic hold flip and the notify stay exactly as they are. Update the header comment ("the SAME definition autoAssign uses" is no longer the claim; autoAssign counts Bartender slots only).
- Tests: `server/utils/lastMinuteStaffingConfirmation.test.js`: a mixed over-fill neither clears the hold nor notifies; approving the barback then does, once.

### Task 4: the desktop reads `rowRoleFill`
- `EventsDashboard.js` Unstaffed filter and count, `OverviewPage.js` `unstaffed`, `queueItems.js` `open`: `rowRoleFill(e).open`.
- `StaffingCell.js` `deriveStaffing`: with a roster, the ratio is `filled/slots` and `open` from `rowRoleFill` (so the column reads 2/3, 1 open, for the over-fill; the confirmed hover card still lists every approved person); with an empty roster it keeps "No roster".
- Tests: the suites for those four files gain the over-fill case; their existing cases stay green.

### Task 5: docs and ledger
- `ARCHITECTURE.md`: the Phone Events list and badge-counts passages say the Needs staff flag and the badge count by role through `openSlotsSql`; drop the "still count heads" clause lane `phone-owner-decisions` added. Any route-table text describing `unstaffed-upcoming` or badge-counts' predicate follows.
- On main after merge: the ledger's QUEUED LANE entry becomes SHIPPED with the squash sha.

## Lane map

- **Lane id:** `staffing-rule-by-role`
- **Footprint:** `server/utils/staffingClassification.js`, `server/utils/staffingClassification.test.js`, `server/utils/positionsNeeded.js`, `server/utils/openSlotsSql.test.js`, `server/routes/shifts.queries.js`, `server/routes/shifts.js`, `server/routes/admin/settings.js`, `server/routes/shifts.adminScoped.test.js`, `server/utils/lastMinuteStaffingConfirmation.js`, `server/utils/lastMinuteStaffingConfirmation.test.js`, `client/src/pages/admin/EventsDashboard.js`, `client/src/pages/admin/overview/OverviewPage.js`, `client/src/pages/admin/overview/queueItems.js`, `client/src/components/adminos/StaffingCell.js`, their client tests, `ARCHITECTURE.md`, `README.md`.
- **Depends on:** `phone-owner-decisions` (merged).
- **Method:** one pass by Claude (small, coherent, shared rule); server suites run one at a time from the repo root against the dev DB, reading the pass count.
- **Review fleet (lane, before merge):** `server/routes/shifts.js` is sensitive-listed, so the full seats that apply: code-review, database-review (the fragment's correctness and its per-row cost on the feed's base CTE and the badge), consistency-check (every staffing count now agrees; the client and server `roleFill` twins match), performance-review. At push: the sensitive-path re-review plus `/second-opinion`.
