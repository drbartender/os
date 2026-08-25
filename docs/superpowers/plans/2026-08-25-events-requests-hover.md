# Events List Requests Hover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hovering the "N requests" chip on the admin Events list shows who applied and what they applied for, oldest request first.

**Architecture:** One lane, two tasks, no schema changes. This is the sibling of the staff-hover feature merged this morning (`21ec7993`) and deliberately reuses its machinery: `StaffHoverCard` is already generic over `{staff, children}`, so no new component is written. Task 1 adds a `pending_staff` aggregate to the admin `GET /shifts` feed, mirroring `approved_staff` but ordered by `created_at` and carrying the requested role rather than the assigned one. Task 2 splits the staffing cell's single hover anchor into two adjacent ones, the ratio keeping the confirmed card and the chip getting the requests card.

**Tech Stack:** Existing stack only, no new dependencies, no new component. Raw SQL via `pg`, Express router, `node --test` with the repo's `node:http` harness, React 18 + jest/RTL (CRA), vanilla CSS in `client/src/index.css`, Playwright MCP for the browser checkpoint.

**Spec:** None. Designed conversationally on 2026-08-25 and settled by Dallas in four decisions, all binding:
1. **Requests only. No waitlist on full-roster rows.** A full roster stays silent exactly as it does today.
2. **Two separate popups, not one sectioned card.** The ratio and the chip each get their own.
3. **Requests are ordered oldest first** (`sr.created_at`), because a requests list is a queue of people awaiting a decision and who has waited longest is the actionable fact. The confirmed card stays alphabetical.
4. The role line shows what they applied for when there is one, and a bare name when there is not.

**Prior art this builds on:** `docs/superpowers/plans/2026-08-25-events-staff-hover.md` (merged `21ec7993`). Read its Task 2 before writing any client code; the portal, the inert card, the above/below flip, and the both-skins CSS all already exist and are not rebuilt here.

**Provenance (verified against main `9d35af61`, 2026-08-25; re-verify before building):**
- `server/routes/shifts.js` is 824 lines (over the 700 soft cap, under the 1000 hard cap: the pre-commit hook warns, never blocks). The admin branch of `router.get('/')` starts at `:104`; its select list now ends with the `approved_staff` subquery added this morning, followed by `FROM shifts s`.
- The `approved_staff` aggregate this one mirrors: `json_agg(json_build_object('user_id', asr.user_id, 'name', COALESCE(acp.display_name, acp.preferred_name, au.email), 'position', asr.position) ORDER BY COALESCE(...))` filtered `asr.status = 'approved' AND asr.dropped_at IS NULL`, aliases `asr`/`au`/`acp` because the outer query owns `u`. The new one needs its own distinct aliases (`psr`/`pu`/`pcp`).
- `rc.pending_count` already exists on the feed: `COUNT(*) FILTER (WHERE sr.status = 'pending')`. The new aggregate MUST agree with it, the same way `approved_staff` agrees with `approved_count`. Note `pending_count` does NOT filter `dropped_at`, and a pending row never carries one (dropping applies to an approved assignment), so no filter is added here either. Do not add one: it would create a disagreement where none exists today.
- `idx_shift_requests_shift_status ON shift_requests(shift_id, status)` (`server/db/schema.sql:2033`) covers the pending lookup. No new index.
- **The `pending_staff` = `pending_count` invariant is EMPIRICAL, not structural.** `shift_requests.user_id` is nullable (`schema.sql:337`); the aggregate INNER JOINs `users`, while `rc.pending_count` joins nothing, so a pending row with a NULL `user_id` would be counted and not listed. Verified zero such rows in prod (95 rows, no null `user_id`, no null `created_at`) and none on dev. `approved_staff`, shipped this morning, carries the identical exposure, so this lane neither introduces nor worsens it. State it plainly to the consistency reviewer rather than claiming the invariant holds by construction.
- **Dev cannot prove the ordering.** Every dev shift with more than one pending request has all of them sharing a single `created_at` (shifts 2, 3, 5 and 17 each show `COUNT(DISTINCT created_at) = 1`), so `ORDER BY created_at` alone is nondeterministic there. Prod has no ties across its 19 shifts with pending requests. Task 1 therefore orders by `created_at, id` for a stable tiebreak, and the browser pass must NOT be used to check ordering.
- **Prod data, queried 2026-08-25 (branch `br-noisy-frog-ad99sa6l`):** `requested_positions` holds `["Bartender"]` on 56 rows (21 pending), `["Banquet Server"]` on 1 (0 pending), and an EMPTY array `[]` on 38 rows (6 still pending). **Nobody has ever ranked more than one position**, so multi-role rendering is a tolerated edge case, not the common path. The empty-array rows are legacy and are the reason the role line must degrade to a bare name.
- `requested_positions` is a JSON-encoded TEXT column with the same two historical shapes as `positions_needed`, so it goes through `parsePositionsNeeded` and never a bare `JSON.parse`. Client precedent: `client/src/pages/staff/ShiftDetail.js:209` does exactly this. Server precedent: `server/utils/positionsNeeded.js`.
- `client/src/components/adminos/StaffingCell.js` currently renders ONE anchor around the whole cell:
  ```jsx
  <StaffHoverCard staff={approvedStaffList(event)}>
    <div className={`vstack staffing-cell...`} style={{ gap: 4, alignItems: 'flex-start' }}>
      {line}
      {pending > 0 && actionable && !inactive && (<StatusChip kind="neutral">{plural(pending, 'request')}</StatusChip>)}
    </div>
  </StaffHoverCard>
  ```
  **This means hovering the chip today shows the CONFIRMED card.** That is a live, if minor, wrongness that Task 2 corrects as a side effect of the split; it is not a regression this plan introduces.
- `StaffHoverCard({ staff, children })` renders `.staff-hover-row` per person with `.staff-hover-name` and, when `p.position` is truthy, `.staff-hover-pos` showing `canonicalizeRole(p.position) || p.position`. It returns `children` untouched when the list is empty, so an anchor with nobody to show costs nothing and adds no wrapper. **It needs no changes for this feature.**
- `canonicalizeRole` (`client/src/utils/staffingRoles.js:19`) returns the canonical label or `null` for anything unrecognized, so a comma-joined multi-role string will NOT canonicalize and will fall through to the raw string. That is correct and intended; see Task 1's decision on where the joining happens.
- The staffing cell's own CSS is `html[data-app="admin-os"] .staffing-cell` (`index.css:13003`) and the hover-card rules are at `:13038`. **The cell's spacing does NOT come from its inline `gap: 4`.** The cell also carries the `vstack` class, and `html[data-app="admin-os"] .vstack { display: flex; flex-direction: column; gap: 0.5rem; }` (`index.css:13392`) supplies a gap of its own. Root font-size is 17px (`:109`), so that is **8.5px**, and the inline `gap: 4` is an OVERRIDE of it, not the source. Deleting the inline style therefore does not remove the dead space between the anchors, it nearly doubles it. Any fix must set the gap to zero explicitly.
- `.staff-hover-anchor` has NO CSS rule of its own today (verified). It is a plain block wrapper.
- **The DOM shape under `.staffing-cell` varies.** `StaffHoverCard` returns its children untouched when its list is empty, and wraps them in `<div class="staff-hover-anchor">` when it is not. So a direct child of the cell is sometimes the anchor and sometimes the wrapped line itself. A CSS rule that assumes one shape (e.g. `.staffing-line + .staffing-line`) matches only in the case where NEITHER element has a card, which is the one case that does not matter. Target `.staffing-cell > * + *` so the rule holds for every permutation.
- `EventsDashboard.js:550` renders `<td><StaffingCell event={e} /></td>`; `StaffingCell` has exactly one consumer.
- **Task 1's SQL was executed against the dev DB on 2026-08-25 and works.** Run against real rows it returned e.g. `[{"user_id":17,"name":"Tony K.","position":"Bartender"},{"user_id":18,"name":"Lisa C.","position":"Bartender"}]`, and `pending_staff.length` equalled `pending_count` on all five sampled rows. The `position` expression was then exercised per-row against every shape the column can hold: `[]` and `not json` and `{"a":1}` and SQL NULL all yield `null` (bare name, no crash), `["Bartender"]` yields `Bartender`, and a two-element array yields `Bartender, Banquet Server`.
- **A trap when re-testing that expression:** with CONSTANT literals instead of a column, Postgres constant-folds both CASE branches and evaluates the invalid cast eagerly, so a literal-based test fails with `invalid input syntax for type json` even though the real query is fine. Test it against a column (a `VALUES` CTE works). The same `IS JSON ARRAY` + CASE guard is the established pattern here: `GET /shifts/unstaffed-upcoming` uses it, and `shifts.unstaffedJsonbGuard.test.js` exists because this exact hazard bit once already.
- Suites that reach the admin feed (nine): `shifts.approval`, `eventDetails`, `shifts.assignEligibility`, `shifts.bonus`, `shifts.unstaffedJsonbGuard`, `shifts.userEvents.bucket`, `shifts.visibility.endInstant`, `shifts.withdraw`, `staffShiftActions`.
- **Do NOT assume which suites fail. Measure it.** An earlier draft of this plan named two as "known-failing", and that instruction is dangerous: `shifts.visibility.endInstant` is TIME-OF-DAY dependent, failing its own "should be finished right now (Chicago HH:MM)" premise in the small hours and **passing 6/6 by morning** (observed failing at 03:29 and 04:06 Chicago, passing at 08:33 and 08:38 the same day). Telling an executor to wave it through would hide a real regression. `shifts.withdraw` is a steadier 10/11, failing on `payouts_pay_period_id_fkey` in its own teardown at `shifts.withdraw.test.js:309`, but that too is a shared-DB artifact rather than a law. Task 0 Step 2 records the real baseline on the day; every later comparison is against THAT, and any suite that was green and goes red is a regression no matter what this document says.

## Global Constraints

- **No em dashes** in copy, comments, commit messages, or docs. Commas, colons, parentheses.
- **Normal effort.** No money, auth, or webhook code. `server/routes/shifts.js` is not sensitive-listed.
- **No waitlist.** Nothing in this lane may cause a full-roster row to display applicants. The chip's existing render condition (`pending > 0 && actionable && !inactive`, where `actionable = open > 0 || needed === 0`) is the gate and is NOT relaxed. A row with a full roster has no chip, therefore no anchor, therefore no card. If a change would make applicants visible on a full roster, it is wrong.
- **No new component.** `StaffHoverCard` is reused as-is. If it appears to need changes, stop and re-read: the requirement was designed so it would not.
- **`requested_positions` is flattened in SQL, and that is a deliberate exception to the usual rule, which must be written into the code comment.** The standing convention is that every reader goes through `parsePositionsNeeded` (`server/utils/positionsNeeded.js`) because the column family holds TWO historical shapes: a flat string array, and a legacy object array `[{position:'bartender',count:2}]`. This plan's SQL handles only the first. On the legacy shape `jsonb_array_elements_text` would emit the object's JSON text and the card would render `{"position": "bartender", "count": 2}` beside the name. That is currently unreachable for THIS column: prod holds only `["Bartender"]` (56 rows), `["Banquet Server"]` (1) and `[]` (38), and the sole writer (`shifts.approval.js`) emits canonical flat arrays. The exception is accepted because doing it in SQL is what keeps the client and `StaffHoverCard` unchanged, but the SQL comment MUST say so, or a future reader will believe the constraint is satisfied when it is not.
- **`pending_staff.length` must equal `rc.pending_count`** on every row, the same invariant `approved_staff` holds against `approved_count`. Pin it with an assertion.
- **Server tests one at a time from the repo root.** Read the pass count, not the exit code.
- **Client:** `cd client` once, then `CI=true npx react-scripts test --watchAll=false <path>`. Gate before any commit touching `client/`: `cd client && CI=true npx react-scripts build` (warnings fail it).
- **CSS scope check is `npm run check:css-scope`,** NOT `test:css-scope` (that runs the checker's own unit tests and is green regardless).
- **Explicit pathspec staging. No backticks in commit messages** (`git commit -F - <<'MSG'`).
- **Build in a lane; merge by squash via `scripts/merge-lane.sh` from `os` on `main`, never from inside the lane.** The lane branch survives until the merge is clean AND the review re-confirms against main's new HEAD.
- **Do not touch other windows' files.** Other sessions commit to this repo continuously. Every commit uses an explicit pathspec, and the merge waits if `os` is dirty.

## Explicitly OUT of scope

- **Folding the feed's correlated subqueries into one LATERAL.** The feed now makes four correlated passes over `shift_requests` (`rc`, `abr`, `approved_staff`, and this lane's `pending_staff`), and folding them into the existing `rc` LATERAL with `FILTER` would cut that to two. It is tempting to do it here since the select list is already being edited, and it is deliberately NOT done: `rc`'s counts are load-bearing for the Events dashboard, the Overview and the admin Dashboard, and changing `FROM shift_requests sr` to a join form risks the count semantics for a page-load optimization nobody has measured a problem with. `idx_shift_requests_shift_status` already covers the new pass. If it is ever worth doing, it wants its own lane, its own before/after `EXPLAIN ANALYZE` on a realistic row count, and its own fleet.
- **A header on the requests card** (e.g. "Requested"). The chip being hovered already says "N requests", and the confirmed card carries no header either. Adding one is chrome.
- **Anything on full-roster rows.** See the Global Constraint.

## Lane map

```yaml
lanes:
  - id: events-requests-hover
    phase: 1
    scope: >
      Hover the "N requests" chip on /events and see who applied and for what,
      oldest first. Server: one pending_staff json aggregate on the admin
      GET /shifts feed. Client: split the staffing cell's single hover anchor
      into two adjacent ones so the ratio and the chip each own their card.
      No new component, no schema change, no waitlist.
    footprint:
      - server/routes/shifts.js
      - server/routes/shifts.approval.test.js
      - client/src/components/adminos/StaffingCell.js
      - client/src/components/adminos/StaffingCell.test.js
      - client/src/index.css
      - README.md
    depends_on: []
    review_fleet: [code-review, consistency-check]
```

---

# Lane events-requests-hover

### Task 0: Open the lane

- [ ] **Step 1: Confirm main is clean and cut the lane**

```bash
cd ~/projects/os && git branch --show-current   # must print: main
git status --short                              # must be empty; if not, another window is mid-edit, wait
npm run worktree:new -- events-requests-hover
cd ../worktrees/events-requests-hover && git log --oneline -1
```

Expected: worktree at `~/projects/worktrees/events-requests-hover` on its own branch, tip equal to main. Every later `cd` is relative to that worktree.

- [ ] **Step 2: Baseline ALL NINE reached suites BEFORE any edit**

```bash
for f in shifts.approval eventDetails shifts.assignEligibility shifts.bonus \
         shifts.unstaffedJsonbGuard shifts.userEvents.bucket \
         shifts.visibility.endInstant shifts.withdraw staffShiftActions; do
  printf "%-34s " "$f"
  node --test server/routes/$f.test.js 2>&1 | grep -E "^ℹ (pass|fail)" | tr '\n' ' '
  echo
done
```

Write the nine numbers down; they are the only thing later runs are compared against. Do NOT assume any of them fails. `shifts.visibility.endInstant` fails its own time-of-day premise in the small hours and passes by morning, and `shifts.withdraw` usually fails 1 on an FK in its own teardown, but both are environment artifacts that come and go. **A suite that is green here and red later is a regression, whatever this plan says about it.** Note the wall-clock Chicago time alongside the numbers, because that is what explains the endInstant result.

---

### Task 1: `pending_staff` on the admin `GET /shifts` feed

Mirrors the `approved_staff` aggregate directly above it, with three deliberate differences: it filters `status = 'pending'`, it orders by `created_at` (oldest first, because this is a queue), and its role comes from `requested_positions` rather than `position`, which is NULL on a pending row until approval resolves it.

**Where the joining happens:** the server flattens `requested_positions` into a single display string and sends it as `position`, so the client and `StaffHoverCard` need no new shape and no new parsing. A single-role array (every real row in prod) sends exactly `"Bartender"`, which `canonicalizeRole` then normalizes client-side just like a confirmed row. An empty array sends `null`, which the card's existing `{p.position && ...}` guard renders as a bare name. A multi-role array (which has never occurred) sends `"Bartender, Banquet Server"`, which will not canonicalize and falls through to the raw string, which is correct.

**Files:**
- Modify: `server/routes/shifts.js`, admin branch of `router.get('/')`, immediately after the `approved_staff` subquery
- Test: `server/routes/shifts.approval.test.js` (append)

**Interfaces:**
- Produces: every row of the admin `GET /api/shifts` response carries `pending_staff: Array<{ user_id: number, name: string, position: string | null }>`, ordered oldest request first, `[]` when nobody has applied. `name` uses the same `COALESCE(display_name, preferred_name, email)` as everywhere else. `position` is the requested role(s), joined by ", ", or `null` when the applicant ranked nothing.

- [ ] **Step 1: Write the failing tests**

Append to `server/routes/shifts.approval.test.js`:

```js
// ─── GET / (admin feed): pending_staff ────────────────────────────

test('admin feed: pending_staff lists applicants oldest first, with what they applied for', async () => {
  const shiftId = await mkShift({ positions: ['Bartender', 'Banquet Server'] });
  // Seeded in this order on purpose: s2 applies FIRST, so an alphabetical or
  // insertion-agnostic ordering puts the wrong person at the top. The requests
  // list is a queue and the person who has waited longest leads it.
  await seedPending(shiftId, s2Id, ['Banquet Server']);
  await seedPending(shiftId, s1Id, ['Bartender']);
  // Backdate s2 so created_at order and INSERTION order are not the same fact.
  // Without this, a json_agg with no ORDER BY at all returns heap order, which
  // happens to match, and the assertion below would pass against a dropped
  // clause. That is the regression most likely to arrive later, via the LATERAL
  // fold this plan defers.
  await pool.query(
    `UPDATE shift_requests SET created_at = NOW() - INTERVAL '1 hour'
      WHERE shift_id = $1 AND user_id = $2`,
    [shiftId, s2Id]
  );
  // An approved person is not an applicant and must not appear here.
  await seedApproved(shiftId, adminId, 'Bartender');

  const r = await req('GET', '/api/shifts', { token: adminToken });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = r.body.find((x) => x.id === shiftId);
  assert.ok(row, 'fixture shift missing from the admin feed');

  assert.ok(Array.isArray(row.pending_staff), 'pending_staff should be a parsed json array');
  assert.deepEqual(row.pending_staff.map((p) => p.user_id), [s2Id, s1Id],
    'oldest request first, not alphabetical and not insertion-agnostic');
  assert.equal(row.pending_staff[0].position, 'Banquet Server', 'the role they applied for');
  assert.equal(row.pending_staff[1].position, 'Bartender');
  assert.equal(row.pending_staff[1].name, 'Reqi One');
  // The names must add up to the count the chip renders.
  assert.equal(Number(row.pending_count), row.pending_staff.length);
  // And an approved person is nowhere in it.
  assert.ok(!row.pending_staff.some((p) => p.user_id === adminId), 'approved is not pending');
});

test('admin feed: an applicant who ranked nothing gets a bare name, not a crash', async () => {
  // 38 prod rows carry an empty requested_positions array, 6 of them still
  // pending. They predate the ranked-role picker. The card renders these as a
  // name with no role line.
  const shiftId = await mkShift({ positions: ['Bartender'] });
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position, requested_positions)
     VALUES ($1, $2, 'pending', NULL, '[]')`,
    [shiftId, s1Id]
  );

  const r = await req('GET', '/api/shifts', { token: adminToken });
  const row = r.body.find((x) => x.id === shiftId);
  assert.ok(row, 'fixture shift missing from the admin feed');
  assert.equal(row.pending_staff.length, 1);
  assert.equal(row.pending_staff[0].position, null, 'no ranked role means no role line');
  assert.equal(Number(row.pending_count), row.pending_staff.length);
});

test('admin feed: a shift with no applicants carries an empty pending_staff, not null', async () => {
  const shiftId = await mkShift({ positions: ['Bartender'] });
  const r = await req('GET', '/api/shifts', { token: adminToken });
  const row = r.body.find((x) => x.id === shiftId);
  assert.ok(row, 'fixture shift missing from the admin feed');
  assert.deepEqual(row.pending_staff, []);
});

test('admin feed: a malformed requested_positions does not 500 the whole feed', async () => {
  // The IS JSON ARRAY guard is a CRASH GUARD, not tidying: without it one bad
  // legacy row raises and takes down the entire events list for every admin.
  // This is the hazard shifts.unstaffedJsonbGuard.test.js exists for on the
  // sibling cast, and nothing else here would notice if the guard were removed.
  const shiftId = await mkShift({ positions: ['Bartender'] });
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position, requested_positions)
     VALUES ($1, $2, 'pending', NULL, 'not json')`,
    [shiftId, s1Id]
  );

  const r = await req('GET', '/api/shifts', { token: adminToken });
  assert.equal(r.status, 200, 'one malformed row must not 500 the feed');
  const row = r.body.find((x) => x.id === shiftId);
  assert.ok(row, 'fixture shift missing from the admin feed');
  assert.equal(row.pending_staff.length, 1);
  assert.equal(row.pending_staff[0].position, null, 'unparseable reads as no role');
});
```

- [ ] **Step 2: Run to verify they fail**

`node --test server/routes/shifts.approval.test.js`

Expected: the three new tests FAIL on `pending_staff` being undefined; every pre-existing test in the file still passes. Note the pass count.

- [ ] **Step 3: Add the aggregate**

In `server/routes/shifts.js`, in the admin branch, directly after the `... ) AS approved_staff` line and before `FROM shifts s`, add a comma to the `approved_staff` line and then:

```sql
        -- Who has APPLIED, for the requests chip's hover card. Sibling of
        -- approved_staff above, with three deliberate differences:
        --   * status = 'pending' (an approved person is not an applicant), and
        --     no dropped_at filter, because dropping applies to an approved
        --     assignment and a pending row never carries one. rc.pending_count
        --     filters the same way, and pending_staff must always equal it.
        --   * ORDER BY created_at: this is a QUEUE, and who has waited longest
        --     is the actionable fact. The confirmed card is alphabetical because
        --     it is a roster, which is a different question.
        --   * the role comes from requested_positions, not position, which is
        --     NULL until approval resolves it. Flattened to a display string
        --     here so the client needs no new shape: one role sends its name, an
        --     empty array sends NULL (38 legacy prod rows, the card then shows a
        --     bare name), several send a comma list (never yet seen in prod).
        -- DELIBERATE EXCEPTION to "every reader goes through parsePositionsNeeded":
        -- this flattens in SQL, which handles the flat-string shape only. The
        -- legacy object shape [{position,count}] would render as raw JSON text.
        -- Unreachable for THIS column (its only writer, shifts.approval.js, emits
        -- canonical flat arrays; prod holds only flat arrays and empties), and
        -- doing it here is what lets StaffHoverCard stay untouched. If that ever
        -- stops being true, move the flatten to the client and use the parser.
        -- The ORDER BY carries `, psr.id` because dev rows share a created_at and
        -- the list would otherwise be nondeterministic there.
        -- Aliases psr/pu/pcp: the outer query owns u and approved_staff owns a*.
        (SELECT COALESCE(json_agg(json_build_object(
                  'user_id', psr.user_id,
                  'name', COALESCE(pcp.display_name, pcp.preferred_name, pu.email),
                  'position', NULLIF(
                    (SELECT string_agg(elem, ', ' ORDER BY ord)
                       FROM jsonb_array_elements_text(
                              CASE WHEN psr.requested_positions IS JSON ARRAY
                                   THEN psr.requested_positions::jsonb
                                   ELSE '[]'::jsonb END
                            ) WITH ORDINALITY AS t(elem, ord)),
                    '')
                ) ORDER BY psr.created_at, psr.id), '[]'::json)
           FROM shift_requests psr
           JOIN users pu ON pu.id = psr.user_id
           LEFT JOIN contractor_profiles pcp ON pcp.user_id = psr.user_id
          WHERE psr.shift_id = s.id AND psr.status = 'pending') AS pending_staff
      FROM shifts s
```

`IS JSON ARRAY` guards the cast the same way `GET /shifts/unstaffed-upcoming` guards its `positions_needed::jsonb` cast: a legacy row holding a non-array would otherwise raise, and this feed must not 500 for one bad row. `WITH ORDINALITY` preserves the applicant's ranking. `NULLIF(..., '')` turns an empty array into a real `null` rather than an empty string, which is what the card's truthiness guard needs.

- [ ] **Step 4: Run to verify it passes**

`node --test server/routes/shifts.approval.test.js`

Expected: `# fail 0`, pass count is the Step 2 count plus 4 (baseline was 34 on 2026-08-25, so 38).

- [ ] **Step 5: Prove the new tests have teeth**

A test that never demonstrates it can fail is not a gate. Break each of these, confirm the named test goes red, then restore:

1. Change `ORDER BY psr.created_at, psr.id` to `ORDER BY psr.user_id` → the ordering assertion must fail.
2. Delete the `ORDER BY` clause entirely → the ordering assertion must STILL fail (this is what the backdating in test 1 buys; without it heap order passes).
3. Change `status = 'pending'` to `status != 'denied'` → the "approved is not pending" assertion must fail.
4. Remove the `IS JSON ARRAY` guard, leaving a bare `psr.requested_positions::jsonb` → the malformed-row test must fail with a 500.

Restore the file exactly (`git diff` should show only the intended addition) and re-run to green before moving on.

- [ ] **Step 6: Run the other eight reached suites, one at a time**

```bash
node --test server/routes/eventDetails.test.js
node --test server/routes/shifts.assignEligibility.test.js
node --test server/routes/shifts.bonus.test.js
node --test server/routes/shifts.unstaffedJsonbGuard.test.js
node --test server/routes/shifts.userEvents.bucket.test.js
node --test server/routes/shifts.visibility.endInstant.test.js
node --test server/routes/shifts.withdraw.test.js
node --test server/routes/staffShiftActions.test.js
```

Expected: all green EXCEPT the two whose Task 0 Step 2 baseline was already failing, which must match that baseline exactly.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint server/routes/shifts.js server/routes/shifts.approval.test.js
git add server/routes/shifts.js server/routes/shifts.approval.test.js
git commit -F - <<'MSG'
feat(events): admin shifts feed carries pending_staff for the requests hover

Sibling of approved_staff: pending only, oldest request first because this is
a queue, and the role comes from requested_positions since position is NULL
until approval resolves it. Flattened server side so the card needs no new
shape, and an applicant who ranked nothing sends null rather than an empty
string.
MSG
```

The file-size hook will warn (`shifts.js` over the 700 soft cap). That is a warning, not a block; do not split the file in this lane.

---

### Task 2: Split the cell into two hover anchors

Today one `StaffHoverCard` wraps the entire cell, so hovering the chip shows the confirmed card. This splits it: the ratio keeps the confirmed card, the chip gets the requests card.

**The gap is the whole problem, and it is not where it looks.** The cell carries an inline `gap: 4`, but that is an OVERRIDE of `.vstack { gap: 0.5rem }` (`index.css:13392`, 8.5px at the 17px root). Deleting the inline style would therefore make the dead zone bigger, not smaller. The gap must be zeroed explicitly, and the 4px of visual spacing re-created as PADDING on the second child, because padding belongs to that element's hit area while a flex gap belongs to nobody. Then the two hover targets are physically contiguous and the pointer crossing between them swaps the card instead of blinking it off.

The selector has to survive a DOM that changes shape: `StaffHoverCard` wraps its child in `.staff-hover-anchor` only when it has someone to show, so a direct child of the cell is sometimes the anchor and sometimes the bare line. `.staffing-cell > * + *` holds in every permutation; a `.staffing-line + .staffing-line` rule would match ONLY when neither element has a card, which is precisely the case where none of this matters.

**Files:**
- Modify: `client/src/components/adminos/StaffingCell.js`
- Test: `client/src/components/adminos/StaffingCell.test.js`
- Modify: `client/src/index.css`

**Interfaces:**
- Consumes: `event.pending_staff` from Task 1.
- Produces: `pendingStaffList(e)` exported from `StaffingCell.js`, the `Array.isArray` guard twin of the existing `approvedStaffList`.

- [ ] **Step 1: Write the failing tests**

Append to `client/src/components/adminos/StaffingCell.test.js`:

```js
describe('pendingStaffList', () => {
  const people = [{ user_id: 1, name: 'A', position: 'Bartender' }];
  test('returns the feed array as-is', () => {
    expect(pendingStaffList({ pending_staff: people })).toBe(people);
  });
  test('a row without the field, or a non-array, reads as nobody', () => {
    expect(pendingStaffList({})).toEqual([]);
    expect(pendingStaffList(null)).toEqual([]);
    expect(pendingStaffList({ pending_staff: '[]' })).toEqual([]);
  });
});

describe('two separate hover anchors', () => {
  const staffedWithRequests = () => ({
    ...ev({ needed: 2, confirmed: 1, pending: 2, days: 19 }),
    approved_staff: [{ user_id: 1, name: 'Confirmed Person', position: 'Bartender' }],
    pending_staff: [
      { user_id: 2, name: 'Applicant One', position: 'Bartender' },
      { user_id: 3, name: 'Applicant Two', position: null },
    ],
  });

  test('the ratio anchor shows the confirmed card only', () => {
    const { container } = render(<StaffingCell event={staffedWithRequests()} />);
    const anchors = container.querySelectorAll('.staff-hover-anchor');
    expect(anchors).toHaveLength(2);
    fireEvent.mouseEnter(anchors[0]);
    const card = screen.getByRole('tooltip');
    expect(card.textContent).toContain('Confirmed Person');
    expect(card.textContent).not.toContain('Applicant One');
  });

  test('the chip anchor shows the applicants, oldest first, and never the confirmed', () => {
    const { container } = render(<StaffingCell event={staffedWithRequests()} />);
    const anchors = container.querySelectorAll('.staff-hover-anchor');
    fireEvent.mouseEnter(anchors[1]);
    const card = screen.getByRole('tooltip');
    const rows = card.querySelectorAll('.staff-hover-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.staff-hover-name').textContent).toBe('Applicant One');
    expect(rows[0].querySelector('.staff-hover-pos').textContent).toBe('Bartender');
    // Ranked nothing: name only, no role line.
    expect(rows[1].querySelector('.staff-hover-name').textContent).toBe('Applicant Two');
    expect(rows[1].querySelector('.staff-hover-pos')).toBeNull();
    expect(card.textContent).not.toContain('Confirmed Person');
  });

  test('a full roster with applicants stays silent: no chip, so no requests card', () => {
    // THE decision this lane must not break. 1/1 with an applicant waiting is a
    // waitlist, it is informational rather than actionable, and this list is
    // where staffing gets worked.
    const event = {
      ...ev({ needed: 1, confirmed: 1, pending: 3 }),
      approved_staff: [{ user_id: 1, name: 'Confirmed Person', position: 'Bartender' }],
      pending_staff: [{ user_id: 2, name: 'Waitlisted Person', position: 'Bartender' }],
    };
    const { container } = render(<StaffingCell event={event} />);
    expect(container.textContent).toBe('1/1');
    expect(container.querySelectorAll('.staff-hover-anchor')).toHaveLength(1);
    fireEvent.mouseEnter(container.querySelector('.staff-hover-anchor'));
    expect(screen.getByRole('tooltip').textContent).not.toContain('Waitlisted Person');
  });

  test('an inactive row shows no chip and therefore no requests card', () => {
    const event = {
      ...ev({ needed: 2, confirmed: 0, pending: 3, days: -5 }),
      pending_staff: [{ user_id: 2, name: 'Past Applicant', position: 'Bartender' }],
    };
    const { container } = render(<StaffingCell event={event} />);
    expect(container.querySelectorAll('.staff-hover-anchor')).toHaveLength(0);
  });

  test('a "No roster" row with applicants DOES get a requests card', () => {
    // needed === 0 makes actionable true, so the chip renders and the applicants
    // are reachable. That is deliberate and consistent with the cell's existing
    // comment: with no declared roster we cannot tell a waitlist from someone
    // filling a real gap, so we surface them rather than hide them. It is the
    // one path where applicants appear without a known open slot, so pin it.
    const event = {
      ...ev({ needed: 0, confirmed: 0, pending: 2 }),
      positions_needed: null,
      approved_staff: [],
      pending_staff: [{ user_id: 9, name: 'Roster-less Applicant', position: 'Bartender' }],
    };
    const { container } = render(<StaffingCell event={event} />);
    expect(container.textContent).toContain('No roster');
    const anchors = container.querySelectorAll('.staff-hover-anchor');
    expect(anchors).toHaveLength(1);
    fireEvent.mouseEnter(anchors[0]);
    expect(screen.getByRole('tooltip').textContent).toContain('Roster-less Applicant');
  });

  test('applicants with an empty confirmed roster still get their own anchor', () => {
    const event = {
      ...ev({ needed: 2, confirmed: 0, pending: 1, days: 19 }),
      approved_staff: [],
      pending_staff: [{ user_id: 2, name: 'Only Applicant', position: 'Bartender' }],
    };
    const { container } = render(<StaffingCell event={event} />);
    // Nobody confirmed means the ratio gets no anchor; the chip still does.
    const anchors = container.querySelectorAll('.staff-hover-anchor');
    expect(anchors).toHaveLength(1);
    fireEvent.mouseEnter(anchors[0]);
    expect(screen.getByRole('tooltip').textContent).toContain('Only Applicant');
  });
});
```

Also update the import line to pull in `pendingStaffList`:

```js
import StaffingCell, { deriveStaffing, approvedStaffList, pendingStaffList } from './StaffingCell';
```

- [ ] **Step 2: Run to verify they fail**

`cd client && CI=true npx react-scripts test --watchAll=false src/components/adminos/StaffingCell.test.js`

Expected: the new tests fail (`pendingStaffList is not a function`, and one anchor found where two are expected). The 28 existing tests still pass.

- [ ] **Step 3: Restructure the cell**

In `client/src/components/adminos/StaffingCell.js`, add the twin selector beside `approvedStaffList`:

```js
// The applicants behind the requests chip, from the feed's pending_staff
// aggregate. Same contract and same reasoning as approvedStaffList.
export function pendingStaffList(e) {
  return Array.isArray(e?.pending_staff) ? e.pending_staff : [];
}
```

Then replace the return so each element owns its own card. The outer `StaffHoverCard` is gone; the `gap: 4` inline style goes with it, replaced by padding on the anchors so the two hit areas touch:

```jsx
  const showChip = pending > 0 && actionable && !inactive;

  return (
    // gap: 0 is LOAD-BEARING, not tidying. `vstack` supplies gap: 0.5rem, and the
    // inline gap: 4 this replaces was overriding it DOWN. Dropping the inline
    // style without this would widen the dead zone between the two hover targets
    // to 8.5px. The 4px of spacing now lives in .staffing-cell > * + * padding,
    // which belongs to the second target's hit area instead of to nobody.
    <div className={`vstack staffing-cell${inactive ? ' staffing-inactive' : ''}`} style={{ gap: 0, alignItems: 'flex-start' }}>
      {/* Two anchors, deliberately adjacent. The ratio answers "who is on this
          event", the chip answers "who wants on it". They are separate cards by
          decision (Dallas, 2026-08-25), and the spacing between them lives in
          .staffing-line padding rather than a flex gap so that dragging from one
          to the other never crosses dead space and blinks the card off. */}
      <StaffHoverCard staff={approvedStaffList(event)}>
        <div className="staffing-line">{line}</div>
      </StaffHoverCard>
      {showChip && (
        <StaffHoverCard staff={pendingStaffList(event)}>
          <div className="staffing-line">
            <StatusChip kind="neutral">{plural(pending, 'request')}</StatusChip>
          </div>
        </StaffHoverCard>
      )}
    </div>
  );
```

`StaffHoverCard` returns its children untouched when the list is empty, so a row with nobody confirmed simply has no anchor around the ratio, and the `.staffing-line` div is harmless in that case.

- [ ] **Step 4: Add the spacing rule**

In `client/src/index.css`, immediately AFTER the closing brace of the `html[data-app="admin-os"] .staff-hover-pos { ... }` rule (locate it by name, do not trust a line number: it sits around `:13058-13061`, and `:13056` is inside `.staff-hover-row`), add:

```css
/* The two staffing hover targets must be physically contiguous, so that dragging
   the pointer from the ratio to the requests chip SWAPS the card rather than
   crossing dead space and blinking it off. Two things make that true:
   the cell's flex gap is zeroed at the call site (see StaffingCell.js, where
   `vstack` would otherwise contribute 8.5px), and the 4px of visual spacing is
   re-created as padding on the second child, which puts it inside that child's
   hit area instead of in a gap belonging to neither.
   The selector is `> * + *` and not `.staffing-line + .staffing-line` because
   StaffHoverCard wraps its child in .staff-hover-anchor only when it has someone
   to show, so the cell's direct children are a MIX of anchors and bare lines. A
   rule keyed on .staffing-line adjacency matches only when neither has a card. */
html[data-app="admin-os"] .staffing-cell > * + * { padding-top: 4px; }
```

Every direct child of the cell is a block-level div under this design (either `.staff-hover-anchor` or, when its list is empty, the `.staffing-line` it would have wrapped), which is what makes the padding land as layout rather than being ignored on an inline element.

- [ ] **Step 5: Run to verify it passes**

`cd client && CI=true npx react-scripts test --watchAll=false src/components/adminos/StaffingCell.test.js`

Expected: PASS, **35 total** (28 existing plus the 7 added in Step 1, plus 1 more if the "No roster" case below is added, making 36). Count them rather than trusting this number. If an existing test now fails on the cell's text content, read it before changing it: the rendered text must be unchanged by this restructure, and a diff there is a real regression, not a stale assertion.

- [ ] **Step 5b: Update the README line this lane makes false**

`README.md:586` currently describes the component as "StaffHoverCard (hover card under that cell listing who is confirmed, name and position; portaled and inert)". After this lane it also lists applicants. Change that parenthetical to read "hover cards under that cell: the ratio lists who is confirmed, the requests chip lists who applied; portaled and inert". The sibling lane updated this exact line, and `scripts/check-docs-drift.sh` watches `client/src/components/`.

- [ ] **Step 6: Gates**

```bash
npm run check:css-scope
cd client
CI=true npx react-scripts test --watchAll=false src/components/adminos
CI=true npx react-scripts build
cd ..
```

(One `cd client`, not three: chained in a single shell the second would fail.)

Expected: scope check clean, all `adminos` suites green, build exit 0 with no warnings from our own source.

- [ ] **Step 7: Browser checkpoint**

jsdom cannot tell you whether two adjacent hover targets feel right, and the previous lane's browser pass is the only reason its fold bug was caught. Same setup as that plan's Task 2 (lane servers on `:5001`/`:3001`, minted admin JWT for user 1, `/events`).

Find a row that has BOTH confirmed staff and applicants:

```bash
node -e "require('dotenv').config(); const {pool}=require('./server/db'); pool.query(\"SELECT s.id, s.event_date::text d, COUNT(*) FILTER (WHERE sr.status='approved' AND sr.dropped_at IS NULL) conf, COUNT(*) FILTER (WHERE sr.status='pending') pend FROM shifts s JOIN shift_requests sr ON sr.shift_id=s.id GROUP BY s.id HAVING COUNT(*) FILTER (WHERE sr.status='pending') > 0 ORDER BY pend DESC LIMIT 5\").then(r=>{console.table(r.rows); return pool.end();})"
```

If no dev row has both, seed one against a fixture shift and delete it afterwards.

**The contiguity check must be MECHANICAL.** `browser_hover` teleports the pointer with no intermediate positions and a one-frame blink is invisible in screenshots, so "drag it slowly and look" cannot verify the binding decision of this lane. jsdom loads no CSS and computes no layout, so the jest run cannot see it either. Measure the geometry instead:

```js
() => {
  const cell = document.querySelector('.staffing-cell');
  const kids = [...cell.children];
  if (kids.length < 2) return 'NEED A ROW WITH BOTH A RATIO AND A CHIP';
  const a = kids[0].getBoundingClientRect();
  const b = kids[1].getBoundingClientRect();
  const seamY = (a.bottom + b.top) / 2;
  const x = a.left + Math.min(a.width, b.width) / 2;
  const hit = document.elementFromPoint(x, seamY);
  return {
    rowGap: getComputedStyle(cell).rowGap,               // MUST be '0px'
    seamGapPx: +(b.top - a.bottom).toFixed(2),           // MUST be <= 0.5
    elementAtSeam: hit && hit.className,                 // MUST be inside an anchor, never bare .staffing-cell
    seamIsCovered: !!(hit && hit.closest('.staff-hover-anchor')),
  };
}
```

`rowGap: '0px'` proves the `vstack` gap was actually zeroed rather than merely overridden downward, and `seamIsCovered: true` proves there is no sliver of cell between the two hit areas for the pointer to fall through. If either fails, the mechanism is broken no matter how it looks.

Then check, and record each answer:
1. Hovering the ratio shows the confirmed people; hovering the chip shows the applicants. Neither shows the other's list.
2. The geometry probe above returns `rowGap: '0px'`, `seamGapPx <= 0.5`, `seamIsCovered: true`.
3. Both cards flip above the anchor near the bottom of a long list, same as the confirmed card does today.
4. Both skins.
5. Clicking the row while either card is showing still opens the event.
6. A full-roster row with applicants shows NO chip and NO applicant card. Verify against a real row if one exists; this is the decision the lane must not break.
7. **New overlap introduced by the split:** the confirmed card anchors 4px below the RATIO now, not below the whole cell, so it paints over the requests chip while it is up. It is `pointer-events: none` so the chip still receives the pointer and the swap still happens, but confirm it reads acceptably rather than looking like a glitch.
8. **Hit-area change:** the anchor used to be the outermost element in the `<td>` and spanned the full cell width; each anchor now shrinks to its own text width inside an `align-items: flex-start` column. Confirm the ratio is still comfortable to hit, and note the width if it feels fussy.
9. Do NOT try to verify ordering here. Every dev shift with multiple pending requests has them sharing one `created_at`, so dev order is nondeterministic by construction; the ordering is pinned by the server test instead.

Stop the two lane servers when done, by PID, leaving any other window's `:3000`/`:5000` alone.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/adminos/StaffingCell.js client/src/components/adminos/StaffingCell.test.js client/src/index.css README.md
git commit -F - <<'MSG'
feat(events): hover the requests chip to see who applied

The cell had one anchor around the whole thing, so hovering the chip showed
the confirmed card. Now the ratio and the chip each own a card: who is on the
event, and who wants on it. Applicants come oldest first and carry the role
they applied for.

The anchors are flush by design. The cell's flex gap is zeroed and the 4px of
spacing moved into the second child's padding, so it belongs to that hover
target instead of to nobody and dragging between them swaps the card instead
of blinking it off. Zeroing is explicit because `vstack` supplies 8.5px of its
own: the inline gap this replaces was overriding that DOWN, not creating it.

A full roster still shows no chip and therefore no applicants.
MSG
```

---

### Task 3: Close out

- [ ] **Step 1: Reached suites, one at a time, compared against the Task 0 baseline**

All nine server suites and the full `adminos` client directory. Record every count. The two known-failing suites must match their baseline exactly; anything else must be green.

- [ ] **Step 2: Pre-merge fleet**

Run `code-review` and `consistency-check` against `git diff main...events-requests-hover`, in the foreground, and state the level ("light fleet, nothing sensitive-listed"). If the repo's agents are not registered in the session, run them as general-purpose agents with the standing instructions from `.claude/agents/<name>.md` inlined; a non-completing agent is not a pass. Point consistency-check specifically at two things. First, `pending_staff` vs `rc.pending_count`: the answer is that they agree empirically but NOT structurally, because `shift_requests.user_id` is nullable and the aggregate INNER JOINs `users` while the count joins nothing (zero such rows in prod or dev today, and `approved_staff` carries the same exposure), so the question is whether that is acceptable rather than whether it is true. Second, whether any other surface now shows applicants differently from this card.

Findings go to Dallas as fix-now or merge-anyway. Do not loop fix-and-re-review.

- [ ] **Step 3: Merge**

```bash
cd ~/projects/os && git status --short   # must be empty; if not, another window is mid-edit, wait for it
scripts/merge-lane.sh events-requests-hover docs/superpowers/plans/2026-08-25-events-requests-hover.md
```

Record the squash sha.

- [ ] **Step 4: Re-confirm against main's new HEAD**

Client build, the `adminos` suites, and `shifts.approval` on main, plus both review agents against the squash commit. Until this passes, the lane branch and worktree stay.

- [ ] **Step 5: File the owed walk**

Add an entry to `docs/walkthroughs-owed.md` Tier 6 naming the squash sha and carrying the ancestor check (`git merge-base --is-ancestor <sha> origin/main`), per that tier's own mechanism. The walk items worth naming: the pointer-drag between the two anchors, and confirming a full-roster row stays silent.

- [ ] **Step 6: Tear down**

Only after Step 4 passes. State all three CLAUDE.md checks in the same breath as the delete: the squash commit is on main, `git diff main events-requests-hover -- <every file the lane touched>` is empty, and the worktree is removed. `npm run worktree:rm -- events-requests-hover --force` (`-d` refuses a squash-merged branch).

- [ ] **Step 7: Board**

`scripts/board-write.sh "Recently shipped" "<one line naming the sha, what it does, and the owed walk>"`.

- [ ] **Step 8: Report**

Pass counts, fleet verdicts, squash sha, browser checkpoint answers, and what is owed. Do not push; the cue is Dallas's.
