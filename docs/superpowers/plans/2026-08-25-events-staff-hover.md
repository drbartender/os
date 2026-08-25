# Events List Staff Hover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hovering the Staffing column on the admin Events list shows who is confirmed on that event, name and position, without leaving the list.

**Architecture:** One lane, three tasks, no schema changes. Task 1 adds an `approved_staff` json aggregate to the admin `GET /shifts` feed, shaped like the `/by-proposal` aggregate and filtered exactly like `approved_count` so the names always add up to the ratio beside them. Task 2 adds a small `StaffHoverCard` component that `StaffingCell` wraps itself in: on mouseenter it measures the cell and portals an inert card to `document.body`, the same escape from the table's overflow clip that `KebabMenu` already uses; the task ends with a real-browser check because jsdom cannot see where a portal lands. Task 3 is the lane close-out under the repo's merge model: reached suites, pre-merge fleet, squash merge through `scripts/merge-lane.sh`, re-confirmation against main's new HEAD, the owed walk filed with its sha, then the worktree teardown.

**Tech Stack:** Existing stack only, no new dependencies. Raw SQL via `pg`, Express router, `node --test` with the repo's `node:http` harness, React 18 + jest/RTL (CRA), `createPortal`, vanilla CSS in `client/src/index.css`, Playwright MCP for the browser checkpoint.

**Spec:** None. The design was agreed in chat on 2026-08-25 and is restated in full here. The self-review that shaped it found four things worth carrying into the code comments: a CSS-only popover would be clipped (`.tbl-wrap { overflow-x: auto }` inside `.card { overflow: hidden }`), pending applicants are deliberately NOT listed (StaffingCell's header explains why the waitlist is hidden on a full roster), the card is hover-only because nothing in the cell is focusable, and the card is inert so it can never stick open or steal the row's mouseup. A `/review-plan` fleet ran on 2026-08-25 (3 blockers, 8 warnings, 6 suggestions, all folded in): the merge path now follows CLAUDE.md's squash model, Task 2 gained a browser checkpoint, the `parseEquipmentArray` generalization was dropped as scope creep, and the walkthrough entry carries its merge sha.

**Provenance (verified against main `548c66c2`, 2026-08-25; re-verify before building. Main moved twice while this plan was written, both docs-only: nothing in the footprint has changed since `33039418`, so these line numbers hold):**
- `server/routes/shifts.js:104-147` `router.get('/')`, admin branch. The select list ends at `:124` with `abr.approved_by_role` and NO trailing comma, then `:125` `FROM shifts s`, `:126` `LEFT JOIN users u ON u.id = s.created_by`. The outer query owns the alias `u`, so the new subquery uses `asr`/`au`/`acp`. `ORDER BY s.event_date ASC LIMIT 500`.
- `server/routes/shifts.js:~326` `/by-proposal/:proposalId` carries an aggregate of the same SHAPE (`json_agg(json_build_object('user_id', ..., 'name', COALESCE(cp.display_name, cp.preferred_name, u.email), 'beo_acknowledged_at', ...) ORDER BY <same COALESCE>)`, filtered `sr.status = 'approved' AND sr.dropped_at IS NULL`). This plan's aggregate swaps the third key for `position`; it is a sibling, not a copy.
- `approved_count` in the admin feed is `COUNT(*) FILTER (WHERE sr.status = 'approved' AND sr.dropped_at IS NULL)`. Same filter, by construction.
- The planned subquery was executed against the dev DB on 2026-08-25: result type is `json` (OID 114, node-pg parses it to an array), `COALESCE(..., '[]'::json)` yields `[]` not null, `Number(approved_count) === approved_staff.length` on all 86 rows, `shifts` has no `approved_staff` column so `SELECT s.*` cannot collide, and 7 of the 14 staffed rows contain a person with `position: null`, so the no-position branch in the card is live data, not defensive fluff. `json_agg` on a NULL position is safe (unlike the `jsonb_object_agg` NULL-key hazard the file documents for `approved_by_role`).
- `contractor_profiles.display_name` exists (`server/db/schema.sql:124`). `shift_requests` has `UNIQUE(shift_id, user_id)` and `dropped_at TIMESTAMPTZ` with no CHECK; the `shift_requests_position_canonical` constraint on dev accepts `'Bartender'` and `'Banquet Server'`.
- `server/routes/shifts.approval.test.js` is the harness to extend: it seeds `adminId`/`adminToken`, staff `s1Id` (contractor profile `preferred_name = 'Reqi One'`, no `display_name`), staff `s2Id` (no profile, so the name resolves to `approval-s2-${NONCE}@example.com`), `fillerId`, one proposal, and defines `mkShift({ positions })`, `seedApproved(shiftId, userId, position)`, `seedPending(shiftId, userId, requestedPositions)`, `req(method, path, { token, body })`. Its `after()` deletes every `shift_requests` and `shifts` row under `proposalId`, so shifts created via `mkShift` need no per-test cleanup. It has no GET test today.
- Dev DB holds 86 shifts, 80 dated on or before the fixture's `CURRENT_DATE + 12`, so a fixture shift is inside the feed's `LIMIT 500` with room to spare.
- `client/src/pages/admin/EventsDashboard.js:550` renders `<td><StaffingCell event={e} /></td>` inside a `React.memo` `EventRow` (default shallow compare on the row object) inside `ClickableRow` (navigates on a clean mouseup). `fetchEvents` does `setEvents(res.data)` and the row is passed through whole, so `approved_staff` reaches the cell with no EventsDashboard edit. The table is at `:435-437`: `<div className="card" style={{ overflow: 'hidden' }}><div className="tbl-wrap"><table className="tbl">`. **There is no EventsDashboard test file**; the design named one, and it does not exist. Coverage of the page comes from the `adminos` suites, the build gate, and Task 2's browser checkpoint.
- `client/src/index.css:12909` `html[data-app="admin-os"] .tbl-wrap { overflow-x: auto; }`. Per CSS, a non-`visible` `overflow-x` forces `overflow-y` to `auto`, so the wrapper clips on both axes. The staffing cell rules end at `:13029-13031` (`.staffing-inactive ... { color: var(--ink-3); }`), followed by `/* progress bar */`.
- `client/src/components/adminos/KebabMenu.js:62-84` is the portal precedent: `getBoundingClientRect()` on the trigger, `createPortal(<div className="kebab-menu" style={{ position: 'absolute', top: r.bottom + window.scrollY + 4, left: ... }} />, document.body)`. Its CSS at `index.css:12530` uses `var(--bg-elev)`, `var(--line-2)`, `var(--radius)`, `var(--shadow-pop)`, `z-index: 1000`; `.kebab-item:hover` uses `var(--ink-1)`. All six tokens this plan uses (`--bg-elev`, `--line-2`, `--radius`, `--shadow-pop`, `--ink-1`, `--ink-3`) are defined in both skins (dark block from `:10946`, light block from `:11224`, `--radius` at `:10919`). `data-app="admin-os"` is set on `<html>` by `client/src/components/AdminLayout.js:67`, so a body-portaled node still matches these selectors. The light skin is `html[data-app="admin-os"][data-skin="light"]`; no `data-skin` is After Hours (dark).
- `client/src/components/adminos/StaffingCell.js` exports `deriveStaffing(e)` and default `StaffingCell({ event })`; the root is `<div className="vstack staffing-cell ...">`. Its header comment says the waitlist on a full roster is deliberately not shown in this cell.
- `client/src/components/adminos/StaffingCell.test.js` has exactly 21 tests, with module-scope `ymd(days)` and `ev({ needed, confirmed, pending, days, status })` helpers; none of the 21 passes `approved_staff`, so they all keep today's render path.
- `@testing-library/react` is 13.4.0; `dist/fire-event.js` wraps `fireEvent.mouseEnter` to also dispatch `mouseover` (and `mouseLeave` to `mouseout`), which is what React 18's `onMouseEnter`/`onMouseLeave` listen to. `screen` queries `document.body`, so portaled content is reachable. `??` appears in 44 client files; optional chaining throughout. `eslint.config.mjs` / `eslint-config-react-app` carry no `react/jsx-no-useless-fragment`; `lint-staged` covers `server/**/*.js` only, so the CRA build is the client gate.
- `README.md:586` is the `adminos/` folder-tree line that names `StatusChip, StaffingCell (...), RainbowDefs, Toolbar, Icon, KebabMenu, ...`. CLAUDE.md:219 makes updating it mandatory for a new component; `scripts/check-docs-drift.sh` warns at commit otherwise.
- `package.json` scripts: `worktree:new`, `worktree:rm` (`scripts/worktree-rm.js <name> [--force]`; deletes the branch with `git branch -d`, which REFUSES a squash-merged branch; `--force` switches to `-D`), `check:css-scope` (`node scripts/check-css-palette-scope.js`, reads the working-tree `index.css`), `test:css-scope` (the checker's OWN unit tests, green regardless of `index.css`; not a gate on new CSS). The pre-commit hook runs the checker with `--staged || true` (warn-only). `scripts/check-file-size.js` scopes `^(server|client/src)/.+\.(js|jsx)$` minus `*.test.js`; `server/routes/shifts.js` is 794 lines (over the 700 soft cap: the hook warns, never blocks under 1000); `index.css` and test files are out of scope.
- `scripts/merge-lane.sh <lane-branch> <plan-link> [lane-name]`: flock-serialized squash merge, refuses unless run from the `os` worktree on `main` with a clean tree, writes `merge(lane <name>): <plan-link>`, and prints that the per-lane review MUST be re-run against the new HEAD before the worktree is removed. CLAUDE.md:144-152 (merge model) and `:25` (the three checks that pre-approve deleting a squash-merged lane branch).
- `scripts/guard-os-main.sh:12` blocks committing anything under `docs/superpowers/(specs|plans)/` from a non-main branch, so this plan doc must be committed on `main` before the lane is cut, or the lane will not contain it and cannot add it.
- `docs/walkthroughs-owed.md:1475` `## Tier 6 — queued: will owe a walkthrough the moment it ships` is currently prose with no items; its body says `**EMPTY AGAIN as of 2026-08-21, and the round trip is the point.**` and prescribes the mechanism: each entry names its merge sha and the check is `git merge-base --is-ancestor <sha> origin/main`; an item moves to Tier 3b when that passes (i.e. after a PUSH, not a merge). Other tiers use `- [ ] **Title**` checkbox items.
- Local admin review: `getSiteContext()` (`client/src/App.js:298`) returns `'app'` for `localhost`, so the admin list is `http://localhost:<port>/events`. Auth is a minted JWT `{ userId, tokenVersion }` signed with `JWT_SECRET` in localStorage key `token` (`client/src/utils/api.js:12`); admin user is `id = 1`. The server reads `process.env.PORT || 5000` (`server/index.js:141`) and its dev CORS accepts any `http://localhost:<port>` origin (`:183`). CRA needs `HOST=localhost DANGEROUSLY_DISABLE_HOST_CHECK=true BROWSER=none` because the shell exports empty `HOST`/`NODE_ENV`; an inline `REACT_APP_API_URL` beats `client/.env`. Another window may already own `:3000`/`:5000`, so the lane runs on `:3001`/`:5001`.
- Suites that call `GET /api/shifts` and therefore reach the Task 1 change (nine): `server/routes/eventDetails.test.js`, `shifts.approval.test.js`, `shifts.assignEligibility.test.js`, `shifts.bonus.test.js`, `shifts.unstaffedJsonbGuard.test.js`, `shifts.userEvents.bucket.test.js`, `shifts.visibility.endInstant.test.js`, `shifts.withdraw.test.js`, `staffShiftActions.test.js`.

## Global Constraints

- **No em dashes** in copy, comments, commit messages, or docs. Commas, colons, parentheses. (Quoted headings from existing files keep whatever they already have.)
- **Normal effort.** No money, auth, or webhook code is touched. `server/routes/shifts.js` is not on `scripts/sensitive-paths.txt`; its listed siblings (`shifts.approval.js`, `shifts.handlers.js`, `staffShiftActions.js`) are not edited, only `shifts.approval.test.js`.
- **Pending applicants are never listed in the card.** Confirmed only (`status = 'approved' AND dropped_at IS NULL`). The cell hides the waitlist on purpose; the card must not reintroduce it.
- **No parser generalization.** `approved_staff` arrives as a parsed json array (pg parses `json`, axios decodes the response). `approvedStaffList` is an `Array.isArray` guard, nothing more. `parseEquipmentArray` and `shifts.js` are not touched.
- **Every new CSS rule is scoped `html[data-app="admin-os"] ...`** and uses skin tokens only. Verify with `npm run check:css-scope` (NOT `test:css-scope`).
- **A new component under `client/src/components/` updates the README folder tree in the same commit** (CLAUDE.md:219).
- **Server tests one at a time from the repo root** (`node --test server/routes/<file>`), never the `npm test` glob while another suite runs: they share the dev DB. Read the pass count, not just the exit code.
- **Client tests:** from the worktree root, `cd client` once, then `CI=true npx react-scripts test --watchAll=false <path-relative-to-client>`. **Client gate before any commit touching `client/`:** `cd client && CI=true npx react-scripts build` (warnings fail it).
- **Explicit pathspec staging only. No backticks in commit messages** (`git commit -F - <<'MSG'` heredoc for commits; `merge-lane.sh` writes the merge message itself).
- **Build in a lane, merge by squash through `scripts/merge-lane.sh`, from `os` on `main`, never from inside the lane.** In-lane checkpoints never reach main. The lane branch survives until the merge is clean AND the fleet is re-confirmed against main's new HEAD.
- **Do not touch the other window's files.** `os` currently carries uncommitted work that is not this plan's (`client/src/components/staff/BeoSections.*`, `client/src/pages/staff/DownloadTipSign.*`, `server/index.js`, `server/middleware/corsOptions.*`). Every commit on main in this plan uses an explicit pathspec, and the merge in Task 3 waits for Dallas if that work is still uncommitted (CLAUDE.md dirty-tree rule).

## Lane map

```yaml
lanes:
  - id: events-staff-hover
    phase: 1
    scope: >
      Hover the Staffing column on /events and see who is confirmed. Server:
      one approved_staff json aggregate on the admin GET /shifts feed. Client:
      a StaffHoverCard component (portal, inert, hover-only) that StaffingCell
      wraps itself in, checked in a real browser before it is committed. No
      schema changes, no money paths, no parser refactor.
    footprint:
      - server/routes/shifts.js
      - server/routes/shifts.approval.test.js
      - client/src/components/adminos/StaffHoverCard.js
      - client/src/components/adminos/StaffHoverCard.test.js
      - client/src/components/adminos/StaffingCell.js
      - client/src/components/adminos/StaffingCell.test.js
      - client/src/index.css
      - README.md
    depends_on: []
    review_fleet: [code-review, consistency-check]
    # Proportionate: nothing sensitive-listed. The visual risk (clip, fold,
    # skins) is covered by the Task 2 browser checkpoint, not by the fleet.
```

Files edited on `main`, outside the lane: this plan (Task 0), `docs/walkthroughs-owed.md` and `docs/build-board.md` (Task 3, after the merge, because the entry needs the squash sha).

---

# Lane events-staff-hover

### Task 0: Commit the plan on main, then open the lane

The plan doc is untracked. `scripts/guard-os-main.sh` refuses `docs/superpowers/plans/` commits from any branch but `main`, so a lane cut now would neither contain the plan nor be able to add it. `os` also carries another window's uncommitted work; an explicit pathspec commits only this file and leaves that alone. `worktree-new.js` does not require a clean tree.

**Files:**
- Commit on main: `docs/superpowers/plans/2026-08-25-events-staff-hover.md`

- [ ] **Step 1: Commit the plan on main with an explicit pathspec**

```bash
cd ~/projects/os && git branch --show-current     # must print: main
git add docs/superpowers/plans/2026-08-25-events-staff-hover.md
git commit -F - <<'MSG'
docs(plan): events-list staff hover, reviewed by the plan fleet
MSG
git status --short    # the other window's files are still listed; that is expected, leave them
```

Expected: one commit containing only the plan file. `git show --stat HEAD` lists exactly one path.

- [ ] **Step 2: Cut the lane**

```bash
cd ~/projects/os && npm run worktree:new -- events-staff-hover
cd ../worktrees/events-staff-hover && git log --oneline -1 && ls docs/superpowers/plans/2026-08-25-events-staff-hover.md
```

Expected: the worktree exists at `~/projects/worktrees/events-staff-hover` on branch `events-staff-hover`, its tip is main's tip (the plan commit), and the plan file is present. Every later `cd` in Tasks 1 and 2 is relative to that worktree.

---

### Task 1: `approved_staff` on the admin `GET /shifts` feed

The events list is fed by this one query. It already computes `approved_count` and `approved_by_role` per row; it does not carry names. The aggregate below has the same shape as `/by-proposal`'s (with `position` in place of `beo_acknowledged_at`) and the same filter as `approved_count`, so the names always add up to the ratio beside them.

**Files:**
- Modify: `server/routes/shifts.js:122-125` (end of the admin select list)
- Test: `server/routes/shifts.approval.test.js` (append a new section at the end of the file)

**Interfaces:**
- Produces: every row of the admin `GET /api/shifts` response carries `approved_staff: Array<{ user_id: number, name: string, position: string | null }>`, ordered by name, `[]` when nobody is confirmed. `name` is `COALESCE(cp.display_name, cp.preferred_name, u.email)`, the rule every other staff-name surface uses. The staff branch of the route is untouched and does not carry the field.

- [ ] **Step 1: Write the failing tests**

Append to the end of `server/routes/shifts.approval.test.js`:

```js
// ─── GET / (admin feed): approved_staff ───────────────────────────

test('admin feed: approved_staff lists confirmed people with name + position, never pending or dropped', async () => {
  const shiftId = await mkShift({ positions: ['Bartender', 'Banquet Server'] });
  await seedApproved(shiftId, s1Id, 'Bartender');          // has a profile: preferred_name 'Reqi One'
  await seedApproved(shiftId, s2Id, 'Banquet Server');     // no profile: name falls back to email
  // A dropped approval is history, not a person on the event.
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position, dropped_at)
     VALUES ($1, $2, 'approved', 'Bartender', NOW())`,
    [shiftId, fillerId]
  );
  // A pending applicant is a request, not staff. The requester's role is
  // irrelevant to the projection; the admin user is just the fourth id we have
  // (shift_requests is UNIQUE on shift_id + user_id, so it must be a fourth).
  await seedPending(shiftId, adminId, ['Bartender']);

  const r = await req('GET', '/api/shifts', { token: adminToken });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = r.body.find((x) => x.id === shiftId);
  assert.ok(row, 'fixture shift missing from the admin feed (LIMIT 500 reached?)');

  assert.ok(Array.isArray(row.approved_staff), 'approved_staff should be a parsed json array');
  const byUser = new Map(row.approved_staff.map((p) => [p.user_id, p]));
  assert.deepEqual([...byUser.keys()].sort((a, b) => a - b), [s1Id, s2Id].sort((a, b) => a - b));
  assert.equal(byUser.get(s1Id).name, 'Reqi One');
  assert.equal(byUser.get(s1Id).position, 'Bartender');
  assert.equal(byUser.get(s2Id).name, `approval-s2-${NONCE}@example.com`);
  assert.equal(byUser.get(s2Id).position, 'Banquet Server');
  // The names must add up to the ratio beside them.
  assert.equal(Number(row.approved_count), row.approved_staff.length);
});

test('admin feed: a shift with nobody confirmed carries an empty approved_staff, not null', async () => {
  const shiftId = await mkShift({ positions: ['Bartender'] });
  const r = await req('GET', '/api/shifts', { token: adminToken });
  const row = r.body.find((x) => x.id === shiftId);
  assert.ok(row, 'fixture shift missing from the admin feed');
  assert.deepEqual(row.approved_staff, []);
});
```

- [ ] **Step 2: Run the suite to verify the new tests fail**

Run from the worktree root: `node --test server/routes/shifts.approval.test.js`

Expected: the two new tests FAIL (`approved_staff should be a parsed json array` / `deepEqual undefined []`); every pre-existing test in the file still passes. Read the summary line: `# fail 2`.

- [ ] **Step 3: Add the aggregate to the admin query**

In `server/routes/shifts.js`, the admin select list currently ends (lines 122-125) with:

```sql
        rc.approved_count,
        rc.pending_count,
        abr.approved_by_role
      FROM shifts s
```

Note there is NO comma after `abr.approved_by_role` today. Replace those four lines with:

```sql
        rc.approved_count,
        rc.pending_count,
        abr.approved_by_role,
        -- Who is confirmed, for the events-list hover card. Same filter as
        -- rc.approved_count (approved AND not dropped) so the names always add
        -- up to the ratio beside them; same name rule as /by-proposal. Pending
        -- applicants are deliberately absent: the cell hides the waitlist on a
        -- full roster (StaffingCell.js header), and the card must not undo that.
        -- Aliases are asr/au/acp because the outer query already owns u.
        (SELECT COALESCE(json_agg(json_build_object(
                  'user_id', asr.user_id,
                  'name', COALESCE(acp.display_name, acp.preferred_name, au.email),
                  'position', asr.position
                ) ORDER BY COALESCE(acp.display_name, acp.preferred_name, au.email)), '[]'::json)
           FROM shift_requests asr
           JOIN users au ON au.id = asr.user_id
           LEFT JOIN contractor_profiles acp ON acp.user_id = asr.user_id
          WHERE asr.shift_id = s.id AND asr.status = 'approved' AND asr.dropped_at IS NULL) AS approved_staff
      FROM shifts s
```

Nothing else in the query changes. The staff branch (`STAFF_OPEN_SHIFTS_SQL`) is not touched.

- [ ] **Step 4: Run the suite to verify it passes**

Run: `node --test server/routes/shifts.approval.test.js`

Expected: `# fail 0`, pass count is the previous count plus 2.

- [ ] **Step 5: Run the other eight suites that read the admin feed, one at a time**

(`shifts.approval.test.js` is the ninth; it just ran in Step 4.)

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

Expected: each ends `# fail 0`. If one dies with `ECONNREFUSED 127.0.0.1:5432`, its dotenv line is missing or the worktree's `.env` symlink is absent; that is an environment failure, not a regression, and it must be fixed before the pass is trusted.

- [ ] **Step 6: Lint and commit (in-lane checkpoint; the squash in Task 3 is what lands on main)**

```bash
npx eslint server/routes/shifts.js server/routes/shifts.approval.test.js
git add server/routes/shifts.js server/routes/shifts.approval.test.js
git commit -F - <<'MSG'
feat(events): admin shifts feed carries approved_staff for the hover card

Same filter as approved_count (approved, not dropped) so the names add up to
the ratio beside them; same name COALESCE as /by-proposal. Pending applicants
are deliberately absent, matching the cell that hides the waitlist.
MSG
```

The file-size hook will print a soft-cap warning for `shifts.js` (794 lines, cap 700). That is a warning, not a block; do not split the file in this lane.

---

### Task 2: `StaffHoverCard` + `StaffingCell` wiring + CSS + README, checked in a browser

One logical feature, one checkpoint commit: the hover card component, the cell that wraps itself in it, the card's CSS, and the README tree line the new component requires. The card is portaled because the events table clips anything positioned inside a cell; it is inert because a card that can be hovered would fight the row's mouseup and could stick open; it is hover-only because nothing in the cell is focusable and a tab stop per row would be noise. jsdom returns an all-zero `getBoundingClientRect`, so the jest tests prove the card mounts and lists the right people; Step 15 proves in a real browser that it escapes the clip, sits under the cell, paints in both skins, and leaves the row clickable.

**Files:**
- Create: `client/src/components/adminos/StaffHoverCard.js`
- Test: `client/src/components/adminos/StaffHoverCard.test.js`
- Modify: `client/src/components/adminos/StaffingCell.js`
- Test: `client/src/components/adminos/StaffingCell.test.js`
- Modify: `client/src/index.css` (insert after the `.staffing-inactive` rule at `~:13031`, before `/* progress bar */`)
- Modify: `README.md:586` (the `adminos/` folder-tree line)

**Interfaces:**
- Consumes: `event.approved_staff` from Task 1 (`Array<{ user_id, name, position }>`), absent on rows from any other feed.
- Produces:
  - `approvedStaffList(e): Array<{ user_id, name, position }>` exported from `StaffingCell.js`: the array when `e.approved_staff` is one, `[]` otherwise.
  - `StaffHoverCard({ staff, children })` default export from `StaffHoverCard.js`. With an empty or non-array `staff` it renders `children` unchanged (no wrapper, no listeners). Otherwise it wraps `children` in `<div class="staff-hover-anchor">` and, while hovered, portals `<div class="staff-hover-card" role="tooltip">` to `document.body`, one `.staff-hover-row` per person with `.staff-hover-name` and (when present) `.staff-hover-pos`.

- [ ] **Step 1: Write the failing `StaffHoverCard` tests**

Create `client/src/components/adminos/StaffHoverCard.test.js`:

```js
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import StaffHoverCard from './StaffHoverCard';

const staff = [
  { user_id: 7, name: 'Reqi One', position: 'Bartender' },
  { user_id: 9, name: 'sam@example.com', position: 'Banquet Server' },
];

test('with nobody confirmed it renders the children bare: no anchor, no card', () => {
  const { container } = render(<StaffHoverCard staff={[]}><span>1/2</span></StaffHoverCard>);
  expect(container.textContent).toBe('1/2');
  expect(container.querySelector('.staff-hover-anchor')).toBeNull();
  expect(screen.queryByRole('tooltip')).toBeNull();
});

test('a non-array staff value is treated as nobody', () => {
  const { container } = render(<StaffHoverCard staff={null}><span>0/1</span></StaffHoverCard>);
  expect(container.querySelector('.staff-hover-anchor')).toBeNull();
});

test('hovering the anchor shows every confirmed person with their position; leaving hides it', () => {
  const { container } = render(<StaffHoverCard staff={staff}><span>2/2</span></StaffHoverCard>);
  expect(screen.queryByRole('tooltip')).toBeNull();

  fireEvent.mouseEnter(container.querySelector('.staff-hover-anchor'));
  const card = screen.getByRole('tooltip');
  expect(card.parentElement).toBe(document.body); // portaled out of the table's overflow clip
  const rows = card.querySelectorAll('.staff-hover-row');
  expect(rows).toHaveLength(2);
  expect(rows[0].querySelector('.staff-hover-name').textContent).toBe('Reqi One');
  expect(rows[0].querySelector('.staff-hover-pos').textContent).toBe('Bartender');
  expect(rows[1].querySelector('.staff-hover-name').textContent).toBe('sam@example.com');
  expect(rows[1].querySelector('.staff-hover-pos').textContent).toBe('Banquet Server');

  fireEvent.mouseLeave(container.querySelector('.staff-hover-anchor'));
  expect(screen.queryByRole('tooltip')).toBeNull();
});

test('a person without a position gets a name and no position span (live shape: 7 dev rows)', () => {
  const { container } = render(
    <StaffHoverCard staff={[{ user_id: 3, name: 'Legacy Row', position: null }]}><span>1/1</span></StaffHoverCard>
  );
  fireEvent.mouseEnter(container.querySelector('.staff-hover-anchor'));
  const row = screen.getByRole('tooltip').querySelector('.staff-hover-row');
  expect(row.querySelector('.staff-hover-name').textContent).toBe('Legacy Row');
  expect(row.querySelector('.staff-hover-pos')).toBeNull();
});

test('unmounting while hovered removes the portaled card', () => {
  const { container, unmount } = render(<StaffHoverCard staff={staff}><span>2/2</span></StaffHoverCard>);
  fireEvent.mouseEnter(container.querySelector('.staff-hover-anchor'));
  expect(screen.getByRole('tooltip')).toBeTruthy();
  unmount();
  expect(screen.queryByRole('tooltip')).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

From the worktree root: `cd client && CI=true npx react-scripts test --watchAll=false src/components/adminos/StaffHoverCard.test.js`

Expected: FAIL, `Cannot find module './StaffHoverCard'`.

- [ ] **Step 3: Create `StaffHoverCard.js`**

Create `client/src/components/adminos/StaffHoverCard.js`:

```js
import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// StaffHoverCard: wraps an anchor (the staffing ratio in the events list) and,
// while the pointer is over it, shows who is confirmed on the event.
//
// Portaled to document.body, like KebabMenu, because the events table sits in
// .tbl-wrap { overflow-x: auto } inside .card { overflow: hidden }: a card
// positioned inside the cell is clipped at the wrapper edge and shoved into a
// scrollbar. Anchored with getBoundingClientRect + scroll offset so it sits
// under the cell and moves with the page.
//
// Inert on purpose (pointer-events: none in CSS). Mousing onto a portaled card
// leaves the anchor, which closes it anyway, so an interactive card gains
// nothing; an inert one can never stick open and never swallows the mouseup
// that ClickableRow uses to navigate.
//
// Hover only. Nothing in the cell is focusable, and a tab stop on every row
// would be noise; keyboard and touch users have the drawer and the event page.
//
// Confirmed people only. The cell deliberately hides the waitlist on a full
// roster (see StaffingCell.js), and this card must not put it back.
export default function StaffHoverCard({ staff, children }) {
  const anchorRef = useRef(null);
  const [anchor, setAnchor] = useState(null);
  const list = Array.isArray(staff) ? staff : [];

  if (list.length === 0) return children;

  const show = () => {
    if (!anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    setAnchor({ top: r.bottom + window.scrollY + 4, left: r.left + window.scrollX });
  };
  const hide = () => setAnchor(null);

  return (
    <>
      <div ref={anchorRef} className="staff-hover-anchor" onMouseEnter={show} onMouseLeave={hide}>
        {children}
      </div>
      {anchor && createPortal(
        <div className="staff-hover-card" role="tooltip" style={{ top: anchor.top, left: anchor.left }}>
          {list.map((p, i) => (
            <div key={p.user_id ?? i} className="staff-hover-row">
              <span className="staff-hover-name">{p.name}</span>
              {p.position && <span className="staff-hover-pos">{p.position}</span>}
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}
```

`useRef` and `useState` are called before the early return on every render, so the hook order is stable. The portal unmounts with the component because it is part of this component's render output.

- [ ] **Step 4: Run to verify it passes**

`cd client && CI=true npx react-scripts test --watchAll=false src/components/adminos/StaffHoverCard.test.js`

Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing `StaffingCell` tests**

In `client/src/components/adminos/StaffingCell.test.js`, change the two imports to:

```js
import { render, screen, fireEvent } from '@testing-library/react';
import StaffingCell, { deriveStaffing, approvedStaffList } from './StaffingCell';
```

and append:

```js
describe('approvedStaffList', () => {
  const people = [{ user_id: 1, name: 'A', position: 'Bartender' }];
  test('returns the feed array as-is (pg parses the json column, axios decodes the body)', () => {
    expect(approvedStaffList({ approved_staff: people })).toBe(people);
  });
  test('a row without the field reads as nobody', () => {
    expect(approvedStaffList({})).toEqual([]);
    expect(approvedStaffList(null)).toEqual([]);
  });
  test('a non-array value is nobody, not a parse attempt', () => {
    expect(approvedStaffList({ approved_staff: JSON.stringify(people) })).toEqual([]);
    expect(approvedStaffList({ approved_staff: { user_id: 1 } })).toEqual([]);
  });
});

describe('hover card wiring', () => {
  test('hovering a staffed cell lists the confirmed people', () => {
    const event = { ...ev({ needed: 2, confirmed: 2 }), approved_staff: [
      { user_id: 1, name: 'Reqi One', position: 'Bartender' },
      { user_id: 2, name: 'Sam Two', position: 'Bartender' },
    ] };
    const { container } = render(<StaffingCell event={event} />);
    expect(container.textContent).toBe('2/2');
    fireEvent.mouseEnter(container.querySelector('.staff-hover-anchor'));
    const card = screen.getByRole('tooltip');
    expect(card.textContent).toContain('Reqi One');
    expect(card.textContent).toContain('Sam Two');
  });

  test('an unstaffed cell has no hover anchor and shows the same copy as before', () => {
    const { container } = render(<StaffingCell event={ev({ needed: 2, confirmed: 0, days: 19 })} />);
    expect(container.querySelector('.staff-hover-anchor')).toBeNull();
    expect(container.textContent).toContain('0/2 · 2 open');
  });

  test('a "No roster" row with nobody confirmed has no hover anchor', () => {
    const { container } = render(
      <StaffingCell event={{ positions_needed: null, approved_count: 0, event_date: ymd(10), approved_staff: [] }} />
    );
    expect(container.textContent).toBe('No roster');
    expect(container.querySelector('.staff-hover-anchor')).toBeNull();
  });

  test('pending applicants are never in the card, only confirmed people', () => {
    // 1/2 with one applicant: the chip says "1 request", the card says one name.
    const event = { ...ev({ needed: 2, confirmed: 1, pending: 1, days: 19 }), approved_staff: [
      { user_id: 1, name: 'Reqi One', position: 'Bartender' },
    ] };
    const { container } = render(<StaffingCell event={event} />);
    expect(container.textContent).toContain('1 request');
    fireEvent.mouseEnter(container.querySelector('.staff-hover-anchor'));
    const card = screen.getByRole('tooltip');
    expect(card.querySelectorAll('.staff-hover-row')).toHaveLength(1);
    expect(card.textContent).not.toContain('request');
  });
});
```

- [ ] **Step 6: Run to verify it fails**

`cd client && CI=true npx react-scripts test --watchAll=false src/components/adminos/StaffingCell.test.js`

Expected: the `approvedStaffList` tests FAIL (`approvedStaffList is not a function`) and the hover tests that expect an anchor FAIL (`.staff-hover-anchor` is null). The 21 existing tests still pass.

- [ ] **Step 7: Wire `StaffingCell`**

In `client/src/components/adminos/StaffingCell.js`:

Add to the imports (after the `StatusChip` import):

```js
import StaffHoverCard from './StaffHoverCard';
```

Add after `deriveStaffing`:

```js
// The confirmed people behind the ratio, from the admin feed's approved_staff
// aggregate (server/routes/shifts.js GET /). pg parses the json column and
// axios decodes the body, so it is an array or it is nothing; no string
// parsing, because there is no path that delivers one.
export function approvedStaffList(e) {
  return Array.isArray(e?.approved_staff) ? e.approved_staff : [];
}
```

Change the component's return so the existing root div is wrapped:

```js
  return (
    <StaffHoverCard staff={approvedStaffList(event)}>
      <div className={`vstack staffing-cell${inactive ? ' staffing-inactive' : ''}`} style={{ gap: 4, alignItems: 'flex-start' }}>
        {line}
        {pending > 0 && actionable && !inactive && (
          <StatusChip kind="neutral">{plural(pending, 'request')}</StatusChip>
        )}
      </div>
    </StaffHoverCard>
  );
```

Nothing inside the div changes. Append to the header comment's last paragraph, after "the waitlist count still lives on the overview and on the event itself.":

```
// The hover card (StaffHoverCard) follows the same rule: it lists confirmed
// people only, never applicants.
```

- [ ] **Step 8: Run to verify it passes**

`cd client && CI=true npx react-scripts test --watchAll=false src/components/adminos/StaffingCell.test.js`

Expected: PASS, 28 tests (21 existing + 3 `approvedStaffList` + 4 hover wiring).

- [ ] **Step 9: Add the CSS**

In `client/src/index.css`, directly after the rule ending `html[data-app="admin-os"] .staffing-inactive .staffing-none { color: var(--ink-3); }` (around line 13031) and before the `/* progress bar */` comment, insert:

```css
/* staffing hover card: who is confirmed on the event. Portaled to body like
   .kebab-menu, because .tbl-wrap { overflow-x: auto } inside .card
   { overflow: hidden } clips anything positioned inside the cell. Inert on
   purpose: it is read, not clicked, so it can never stick open or take the
   row's mouseup away from ClickableRow. Skin tokens only, so House Lights and
   After Hours both paint it. */
html[data-app="admin-os"] .staff-hover-card {
  position: absolute;
  z-index: 1000;
  pointer-events: none;
  background: var(--bg-elev);
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  box-shadow: var(--shadow-pop);
  padding: 6px 10px;
  font-size: 12.5px;
  color: var(--ink-1);
}
/* name, then the position muted after it: one line per person, no columns */
html[data-app="admin-os"] .staff-hover-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
  white-space: nowrap;
}
html[data-app="admin-os"] .staff-hover-pos {
  color: var(--ink-3);
  font-size: 11px;
}
```

No rule for `.staff-hover-anchor`: it is a plain block wrapper and needs none.

- [ ] **Step 10: Update the README folder tree**

In `README.md:586`, the `adminos/` line reads (in part):

```
StatusChip, StaffingCell (events-list staffing column: confirmed/needed with a red shortfall, plus a requests-vs-waitlist chip), RainbowDefs,
```

Change it to:

```
StatusChip, StaffingCell (events-list staffing column: confirmed/needed with a red shortfall, plus a requests-vs-waitlist chip), StaffHoverCard (hover card under that cell listing who is confirmed, name and position; portaled and inert), RainbowDefs,
```

- [ ] **Step 11: CSS scope check and client gate**

From the worktree root:

```bash
npm run check:css-scope
cd client && CI=true npx react-scripts build
```

Expected: the checker reports the working-tree `index.css` clean (every new rule is `html[data-app="admin-os"] .staff-hover-*` on `--ink`/`--bg` tokens, which its admin-scope branch accepts); the build completes with no warnings.

- [ ] **Step 12: Start the lane's own servers on side ports**

Another window may own `:3000`/`:5000`; the lane uses `:5001`/`:3001` so nothing of anyone else's is stopped. The worktree already has `.env` and `client/.env` symlinked by `worktree-new`. The backend is a plain `node` process (no reload), so it must be started AFTER Task 1's edit, which it is.

```bash
# from the worktree root
NODE_ENV=development PORT=5001 node server/index.js > /tmp/claude-1000/-home-drbartender/9fdbcb8b-bf54-41e9-b429-4fad0629e434/scratchpad/lane-server.log 2>&1 &
sleep 4 && grep -E "Database schema initialized|Server running on port 5001" /tmp/claude-1000/-home-drbartender/9fdbcb8b-bf54-41e9-b429-4fad0629e434/scratchpad/lane-server.log
cd client && PORT=3001 HOST=localhost DANGEROUSLY_DISABLE_HOST_CHECK=true BROWSER=none REACT_APP_API_URL=http://localhost:5001 npx react-scripts start > /tmp/claude-1000/-home-drbartender/9fdbcb8b-bf54-41e9-b429-4fad0629e434/scratchpad/lane-client.log 2>&1 &
```

Expected: the server log shows both lines; the client log reaches `Compiled successfully` (allow ~60s). Run these with the Bash tool's `run_in_background` rather than a literal `&` where possible.

- [ ] **Step 13: Mint an admin JWT for the browser**

```bash
node -e "require('dotenv').config(); const jwt=require('jsonwebtoken'); const {pool}=require('./server/db'); pool.query('SELECT token_version FROM users WHERE id = 1').then(r => { console.log(jwt.sign({ userId: 1, tokenVersion: r.rows[0].token_version }, process.env.JWT_SECRET)); return pool.end(); })"
```

Expected: one JWT on stdout. It is a dev-DB credential for the admin account; use it only in the local browser session below and do not paste it into any file, commit, or report.

- [ ] **Step 14: Find a staffed event to hover**

```bash
node -e "require('dotenv').config(); const {pool}=require('./server/db'); pool.query(\"SELECT s.id, s.proposal_id, s.event_date, COUNT(*) AS n FROM shifts s JOIN shift_requests sr ON sr.shift_id = s.id AND sr.status = 'approved' AND sr.dropped_at IS NULL GROUP BY s.id ORDER BY s.event_date DESC LIMIT 5\").then(r => { console.table(r.rows); return pool.end(); })"
```

Expected: up to five staffed shifts (dev has 14). Note the most recent one's `event_date` and `proposal_id`; if it is in the past, the list's **All** tab is where it renders.

- [ ] **Step 15: Browser checkpoint (Playwright MCP, desktop viewport)**

Load the Playwright MCP tools (`ToolSearch "select:mcp__plugin_playwright_playwright__browser_navigate,mcp__plugin_playwright_playwright__browser_evaluate,mcp__plugin_playwright_playwright__browser_hover,mcp__plugin_playwright_playwright__browser_take_screenshot,mcp__plugin_playwright_playwright__browser_click,mcp__plugin_playwright_playwright__browser_resize"`), then:

1. `browser_resize` to 1440 x 900 (desktop; the admin PWA lock screen is a phone-context concern and should not appear, and if it does, that is a note for the report, not this lane's bug).
2. `browser_navigate` to `http://localhost:3001/events`.
3. `browser_evaluate`: `localStorage.setItem('token', '<the JWT from Step 13>'); location.reload();`
4. If the staffed shift from Step 14 is in the past, click the **All** tab.
5. `browser_hover` on the `.staff-hover-anchor` of that event's row. Expected: a card appears directly under the ratio listing the confirmed names, each with its position muted after it.
6. `browser_evaluate` and record the result:
   ```js
   (() => {
     const card = document.querySelector('[role="tooltip"]');
     if (!card) return 'NO CARD';
     const c = card.getBoundingClientRect();
     const wrap = document.querySelector('.tbl-wrap').getBoundingClientRect();
     const mid = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
     return {
       cardVisibleInViewport: c.top >= 0 && c.bottom <= window.innerHeight && c.left >= 0 && c.right <= window.innerWidth,
       overlapsWrapperEdge: c.bottom > wrap.bottom,   // informational: true means the portal is doing its job
       topElementAtCardCenter: mid && mid.className,   // must be a staff-hover-* element, never the row or the wrapper
       rows: card.querySelectorAll('.staff-hover-row').length,
     };
   })()
   ```
   Expected: `cardVisibleInViewport: true`, `topElementAtCardCenter` is `staff-hover-card`, `staff-hover-row`, `staff-hover-name` or `staff-hover-pos` (an `elementFromPoint` that returns the row or `tbl-wrap` means the card is painted UNDER something and the check is a false pass; see the Playwright clipped-control lesson in memory), and `rows` equals the count from Step 14.
7. `browser_take_screenshot` (After Hours, the default skin).
8. `browser_evaluate`: `document.documentElement.setAttribute('data-skin', 'light')`, re-hover, `browser_take_screenshot` (House Lights). Expected: the card is legible on the light paper, ink on `--bg-elev`, not cream text on cream.
9. Scroll so the staffed row is the LAST visible row (`browser_evaluate`: `document.querySelector('.staff-hover-anchor').scrollIntoView({ block: 'end' })`), re-hover, and re-run the Step 6 evaluate. Expected: the card still passes `cardVisibleInViewport` or, if it would fall below the fold, the page scrolls to it (an `absolute` card in `body` extends the document, it is not clipped). Either outcome is fine; a card cut off with no way to scroll to it is a failure.
10. With the card showing, `browser_click` on the row's client-name cell. Expected: the URL changes to `/events/<proposal_id>` (or the shift drawer opens for a manual shift); the card is gone; no console error.
11. Look at both screenshots yourself before moving on. A card that renders where the numbers say it should but looks wrong (wrong font, wrong contrast, overlapping the next row's text) is a finding.

Stop the two lane servers when done (they are yours; find the two PIDs on `:5001` and `:3001` and stop only those).

- [ ] **Step 16: Commit (in-lane checkpoint)**

```bash
git add client/src/components/adminos/StaffHoverCard.js client/src/components/adminos/StaffHoverCard.test.js \
        client/src/components/adminos/StaffingCell.js client/src/components/adminos/StaffingCell.test.js \
        client/src/index.css README.md
git commit -F - <<'MSG'
feat(events): hover the Staffing column to see who is confirmed

StaffHoverCard portals an inert, hover-only card to body (the table wrapper
clips anything positioned in the cell). Confirmed people only, matching the
cell that hides the waitlist. Checked in a real browser in both skins.
MSG
```

---

### Task 3: Lane close-out under the merge model

Order matters here and is the repo's, not this plan's: reached suites, pre-merge fleet, squash merge through the locked wrapper, fleet re-confirmed against main's new HEAD, then the docs that need the squash sha, then and only then the worktree teardown.

**Files:**
- Modify on `main`, after the merge: `docs/walkthroughs-owed.md` (Tier 6), `docs/build-board.md` via `scripts/board-write.sh` only

- [ ] **Step 1: Run every suite the change reaches, from the worktree root, one at a time**

Client, from the worktree root, `cd client` once:

```bash
cd client
CI=true npx react-scripts test --watchAll=false src/components/adminos/StaffingCell.test.js
CI=true npx react-scripts test --watchAll=false src/components/adminos/StaffHoverCard.test.js
CI=true npx react-scripts test --watchAll=false src/components/adminos
cd ..
```

Server, all nine, one at a time:

```bash
node --test server/routes/shifts.approval.test.js
node --test server/routes/eventDetails.test.js
node --test server/routes/shifts.assignEligibility.test.js
node --test server/routes/shifts.bonus.test.js
node --test server/routes/shifts.unstaffedJsonbGuard.test.js
node --test server/routes/shifts.userEvents.bucket.test.js
node --test server/routes/shifts.visibility.endInstant.test.js
node --test server/routes/shifts.withdraw.test.js
node --test server/routes/staffShiftActions.test.js
```

Record every pass count for the final report; a count that dropped from an earlier run is a finding, not noise. There is no EventsDashboard suite to run; the `adminos` directory run plus the build gate and the Task 2 browser checkpoint are that page's coverage.

- [ ] **Step 2: Pre-merge review fleet on the lane**

From the lane, run `code-review` and `consistency-check` against `git diff main...events-staff-hover`, in the foreground. State the level run ("light fleet, nothing sensitive-listed"). Findings go to Dallas as fix-now or merge-anyway; do not loop fix and re-review on your own. A non-completing or inconclusive agent is not a pass; re-dispatch it once.

- [ ] **Step 3: Squash-merge through the wrapper**

```bash
cd ~/projects/os && git branch --show-current && git status --short
```

If `git status --short` prints anything, STOP: that is the other window's uncommitted work (or a quick fix), and `merge-lane.sh` refuses a dirty tree by design. Ask Dallas to commit or park it; never stash someone else's files yourself.

When clean:

```bash
cd ~/projects/os && scripts/merge-lane.sh events-staff-hover docs/superpowers/plans/2026-08-25-events-staff-hover.md
git log --oneline -1
```

Expected: one squash commit on main titled `merge(lane events-staff-hover): docs/superpowers/plans/2026-08-25-events-staff-hover.md`, and the script's notice that the review must be re-run against the new HEAD. Record the squash sha; Steps 5, 6 and 7 all use it.

- [ ] **Step 4: Re-confirm against main's new HEAD**

On `main` in `~/projects/os`:

```bash
cd client && CI=true npx react-scripts build && cd ..
cd client && CI=true npx react-scripts test --watchAll=false src/components/adminos && cd ..
node --test server/routes/shifts.approval.test.js
```

Then re-run `code-review` and `consistency-check` against the squash commit (`git show <squash-sha>`), foreground. Expected: build clean, suites at the Step 1 counts, fleet clean or findings to Dallas. Until this step passes, the lane branch and worktree stay.

- [ ] **Step 5: File the owed walk with its sha**

In `docs/walkthroughs-owed.md`, under `## Tier 6 — queued: will owe a walkthrough the moment it ships`:

Change the bold lead-in `**EMPTY AGAIN as of 2026-08-21, and the round trip is the point.**` to `**One item as of 2026-08-25; before that, EMPTY AGAIN as of 2026-08-21, and the round trip is the point.**` (leave the rest of that paragraph as it is).

Then append, after the paragraph ending "Do that again for the next thing that sits here.", using the checkbox form the other tiers use:

```
- [ ] **Events list staff hover** (lane events-staff-hover, merge sha `<squash-sha>`; live when
  `git merge-base --is-ancestor <squash-sha> origin/main` exits 0, then move this to Tier 3b).
  On /events, hover the Staffing column on a staffed row: a card lists everyone confirmed, name
  and position. Checked headless in both skins on the dev DB; the walk is the real thing in
  prod: both skins, the last row of a long list, and clicking the row while the card is showing
  still opens the event. Unstaffed rows and "No roster" rows show no card. Hover only, no phone
  or keyboard path, by design.
```

```bash
cd ~/projects/os && git add docs/walkthroughs-owed.md
git commit -F - <<'MSG'
docs: queue the events-list staff hover walk with its merge sha
MSG
```

The entry moves to Tier 3b on PUSH (when the ancestor check passes), not now; this plan does not push.

- [ ] **Step 6: Tear down the lane (the three pre-approved checks first)**

`worktree-rm` uses `git branch -d`, which refuses a squash-merged branch, so this needs `--force`, and CLAUDE.md:25 pre-approves that deletion only when all three checks pass and are stated in the same breath:

```bash
cd ~/projects/os
git log main --oneline --grep "merge(lane events-staff-hover" | head -1        # (1) the squash is on main
git diff main events-staff-hover -- server/routes/shifts.js server/routes/shifts.approval.test.js \
  client/src/components/adminos/StaffHoverCard.js client/src/components/adminos/StaffHoverCard.test.js \
  client/src/components/adminos/StaffingCell.js client/src/components/adminos/StaffingCell.test.js \
  client/src/index.css README.md | wc -l                                          # (2) must print 0
npm run worktree:rm -- events-staff-hover --force                                # removes the worktree (3), then -D the branch
```

Expected: (1) prints the squash commit, (2) prints `0`, and the script reports the worktree removed and the branch deleted. If (2) is non-zero, stop: the branch holds something main does not, and deleting it is back to per-action approval.

- [ ] **Step 7: Board**

```bash
cd ~/projects/os && scripts/board-write.sh "Recently shipped" "**events-staff-hover (merged $(date +%Y-%m-%d), <squash-sha>)**: hover the Staffing column on /events to see who is confirmed, name and position. Server: approved_staff on the admin shifts feed. Client: StaffHoverCard, portaled and inert, browser-checked in both skins. OWED: Dallas's prod walk (walkthroughs-owed Tier 6, moves on push). [plan](superpowers/plans/2026-08-25-events-staff-hover.md)"
```

(The line passes the board's denylist; it was checked with `board-write.sh --check` on 2026-08-25. `board-write` commits locally and pushes only when its commit is the sole unpushed one, which it will not be, so it rides the next push.)

- [ ] **Step 8: Report**

State the pass counts from Steps 1 and 4, both fleet verdicts, the squash sha, the two screenshots' verdicts from Task 2 Step 15, and that the walk is owed. Do not say "pushed" and do not push: a push cue comes from Dallas.
