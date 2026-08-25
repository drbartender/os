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
- The staffing cell's own CSS is `html[data-app="admin-os"] .staffing-cell` (`index.css:13003`) and the hover-card rules are at `:13038`. The cell's `gap: 4` is an inline style on the div, NOT in CSS.
- `EventsDashboard.js:550` renders `<td><StaffingCell event={e} /></td>`; `StaffingCell` has exactly one consumer.
- **Task 1's SQL was executed against the dev DB on 2026-08-25 and works.** Run against real rows it returned e.g. `[{"user_id":17,"name":"Tony K.","position":"Bartender"},{"user_id":18,"name":"Lisa C.","position":"Bartender"}]`, and `pending_staff.length` equalled `pending_count` on all five sampled rows. The `position` expression was then exercised per-row against every shape the column can hold: `[]` and `not json` and `{"a":1}` and SQL NULL all yield `null` (bare name, no crash), `["Bartender"]` yields `Bartender`, and a two-element array yields `Bartender, Banquet Server`.
- **A trap when re-testing that expression:** with CONSTANT literals instead of a column, Postgres constant-folds both CASE branches and evaluates the invalid cast eagerly, so a literal-based test fails with `invalid input syntax for type json` even though the real query is fine. Test it against a column (a `VALUES` CTE works). The same `IS JSON ARRAY` + CASE guard is the established pattern here: `GET /shifts/unstaffed-upcoming` uses it, and `shifts.unstaffedJsonbGuard.test.js` exists because this exact hazard bit once already.
- Suites that reach the admin feed (nine): `shifts.approval`, `eventDetails`, `shifts.assignEligibility`, `shifts.bonus`, `shifts.unstaffedJsonbGuard`, `shifts.userEvents.bucket`, `shifts.visibility.endInstant`, `shifts.withdraw`, `staffShiftActions`. **Two fail on clean main for reasons unrelated to any of this**: `shifts.visibility.endInstant` fails its own "should be finished right now (Chicago HH:MM)" premise in the small hours, and `shifts.withdraw` hits an FK violation in its own teardown (`pay_periods` still referenced by `payouts`). Establish a baseline before changing anything and compare against it; do not read either as a regression.

## Global Constraints

- **No em dashes** in copy, comments, commit messages, or docs. Commas, colons, parentheses.
- **Normal effort.** No money, auth, or webhook code. `server/routes/shifts.js` is not sensitive-listed.
- **No waitlist.** Nothing in this lane may cause a full-roster row to display applicants. The chip's existing render condition (`pending > 0 && actionable && !inactive`, where `actionable = open > 0 || needed === 0`) is the gate and is NOT relaxed. A row with a full roster has no chip, therefore no anchor, therefore no card. If a change would make applicants visible on a full roster, it is wrong.
- **No new component.** `StaffHoverCard` is reused as-is. If it appears to need changes, stop and re-read: the requirement was designed so it would not.
- **`requested_positions` goes through `parsePositionsNeeded`,** never a bare `JSON.parse`.
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

- [ ] **Step 2: Baseline the two known-failing suites BEFORE any edit**

```bash
node --test server/routes/shifts.visibility.endInstant.test.js 2>&1 | grep -E "^ℹ (pass|fail)"
node --test server/routes/shifts.withdraw.test.js 2>&1 | grep -E "^ℹ (pass|fail)"
```

Record both numbers. They are expected to be non-zero-fail on a clean tree. Any later comparison is against THESE numbers, not against zero.

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
  assert.deepEqual(row.pending_staff, []);
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
                ) ORDER BY psr.created_at), '[]'::json)
           FROM shift_requests psr
           JOIN users pu ON pu.id = psr.user_id
           LEFT JOIN contractor_profiles pcp ON pcp.user_id = psr.user_id
          WHERE psr.shift_id = s.id AND psr.status = 'pending') AS pending_staff
      FROM shifts s
```

`IS JSON ARRAY` guards the cast the same way `GET /shifts/unstaffed-upcoming` guards its `positions_needed::jsonb` cast: a legacy row holding a non-array would otherwise raise, and this feed must not 500 for one bad row. `WITH ORDINALITY` preserves the applicant's ranking. `NULLIF(..., '')` turns an empty array into a real `null` rather than an empty string, which is what the card's truthiness guard needs.

- [ ] **Step 4: Run to verify it passes**

`node --test server/routes/shifts.approval.test.js`

Expected: `# fail 0`, pass count is the Step 2 count plus 3.

- [ ] **Step 5: Prove the new tests have teeth**

A test that never demonstrates it can fail is not a gate. Break each of these, confirm the named test goes red, then restore:

1. Change `ORDER BY psr.created_at` to `ORDER BY psr.user_id` → the ordering assertion must fail.
2. Change `status = 'pending'` to `status != 'denied'` → the "approved is not pending" assertion must fail.

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

**The gap matters.** The cell is a `vstack` with an inline `gap: 4`, which is dead space belonging to neither anchor. With two anchors, dragging the pointer from the ratio to the chip would cross it and leave a frame with no card, a visible blink at slow pointer speeds. Removing the inline `gap` and giving each anchor its own bottom/top padding makes the two hit areas adjacent, so the swap is immediate with no dead zone and the visual spacing is unchanged.

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
    <div className={`vstack staffing-cell${inactive ? ' staffing-inactive' : ''}`} style={{ alignItems: 'flex-start' }}>
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

In `client/src/index.css`, immediately after the `.staff-hover-pos` rule added by the previous lane (around `:13056`), add:

```css
/* The two staffing anchors sit flush against each other so the pointer can
   cross from the ratio to the requests chip without passing through dead
   space, which would blink the hover card off mid-gesture. The visual spacing
   the cell used to get from `gap: 4` lives here instead. */
html[data-app="admin-os"] .staffing-line { padding-bottom: 2px; }
html[data-app="admin-os"] .staffing-line + .staffing-line { padding-bottom: 0; padding-top: 2px; }
```

- [ ] **Step 5: Run to verify it passes**

`cd client && CI=true npx react-scripts test --watchAll=false src/components/adminos/StaffingCell.test.js`

Expected: PASS, 28 existing plus 8 new. If an existing test now fails on the cell's text content, read it before changing it: the rendered text must be unchanged by this restructure, and a diff there is a real regression, not a stale assertion.

- [ ] **Step 6: Gates**

```bash
npm run check:css-scope
cd client && CI=true npx react-scripts test --watchAll=false src/components/adminos
cd client && CI=true npx react-scripts build
```

Expected: scope check clean, all `adminos` suites green, build exit 0 with no warnings from our own source.

- [ ] **Step 7: Browser checkpoint**

jsdom cannot tell you whether two adjacent hover targets feel right, and the previous lane's browser pass is the only reason its fold bug was caught. Same setup as that plan's Task 2 (lane servers on `:5001`/`:3001`, minted admin JWT for user 1, `/events`).

Find a row that has BOTH confirmed staff and applicants:

```bash
node -e "require('dotenv').config(); const {pool}=require('./server/db'); pool.query(\"SELECT s.id, s.event_date::text d, COUNT(*) FILTER (WHERE sr.status='approved' AND sr.dropped_at IS NULL) conf, COUNT(*) FILTER (WHERE sr.status='pending') pend FROM shifts s JOIN shift_requests sr ON sr.shift_id=s.id GROUP BY s.id HAVING COUNT(*) FILTER (WHERE sr.status='pending') > 0 ORDER BY pend DESC LIMIT 5\").then(r=>{console.table(r.rows); return pool.end();})"
```

If no dev row has both, seed one against a fixture shift and delete it afterwards.

Check, and record each answer:
1. Hovering the ratio shows the confirmed people; hovering the chip shows the applicants. Neither shows the other's list.
2. Drag the pointer slowly from the ratio down onto the chip. The card must SWAP, not blink off and back on. This is the specific thing Step 4's CSS exists to prevent; if it blinks, the padding rule is not doing its job.
3. Both cards flip above the anchor near the bottom of a long list, same as the confirmed card does today.
4. Both skins.
5. Clicking the row while either card is showing still opens the event.
6. A full-roster row with applicants shows NO chip and NO applicant card. Verify against a real row if one exists; this is the decision the lane must not break.

Stop the two lane servers when done, by PID, leaving any other window's `:3000`/`:5000` alone.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/adminos/StaffingCell.js client/src/components/adminos/StaffingCell.test.js client/src/index.css
git commit -F - <<'MSG'
feat(events): hover the requests chip to see who applied

The cell had one anchor around the whole thing, so hovering the chip showed
the confirmed card. Now the ratio and the chip each own a card: who is on the
event, and who wants on it. Applicants come oldest first and carry the role
they applied for.

The anchors are flush by design. The cell's flex gap became padding inside
each one so dragging between them swaps the card instead of blinking it off.

A full roster still shows no chip and therefore no applicants.
MSG
```

---

### Task 3: Close out

- [ ] **Step 1: Reached suites, one at a time, compared against the Task 0 baseline**

All nine server suites and the full `adminos` client directory. Record every count. The two known-failing suites must match their baseline exactly; anything else must be green.

- [ ] **Step 2: Pre-merge fleet**

Run `code-review` and `consistency-check` against `git diff main...events-requests-hover`, in the foreground, and state the level ("light fleet, nothing sensitive-listed"). If the repo's agents are not registered in the session, run them as general-purpose agents with the standing instructions from `.claude/agents/<name>.md` inlined; a non-completing agent is not a pass. Point consistency-check specifically at whether `pending_staff` and `rc.pending_count` can ever disagree, and at whether any other surface now shows applicants differently.

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
