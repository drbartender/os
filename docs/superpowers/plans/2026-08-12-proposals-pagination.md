# Proposals List Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Proposals dashboard a working Prev/Next pager so all 219 Active proposals are reachable, not just the first 50.

**Architecture:** Client-only. `server/routes/proposals/list.js` already accepts `?page`/`?limit` and returns `X-Total-Count`; the dashboard simply never sends `page`. Page number becomes one more key in the existing `useUrlListState` URL state, so it composes with the tab/filter/sort machinery already there and survives refresh, Back, and cross-nav drill-outs. Every filter write funnels through a single wrapper that resets the page, which is the one behavior that makes or breaks a pager.

**Tech Stack:** React 18 (CRA), React Router 6, `useUrlListState`, vanilla CSS in `index.css`.

**Spec:** `docs/superpowers/specs/2026-08-12-proposals-pagination-design.md` (approved 2026-08-12)

## Global Constraints

- **No em dashes** in any copy, comment prose, or UI string. Commas, colons, parentheses only.
- **No server change.** `server/routes/proposals/list.js` is already correct and is out of footprint. If the pager appears to need a server edit, stop and surface it rather than widening.
- **`PAGE_SIZE` is sent explicitly.** The client defines `PAGE_SIZE = 50` and puts it on the request as `limit`. Do not rely on the server's default matching, because a silent divergence would make `pageCount` wrong with no error anywhere.
- **Only the pager writes `page`.** Every other control writes through `setFilters`, which resets to page 1. A `setListState` call that changes the filtered set without resetting the page is the defect this plan exists to avoid.
- **Frontend API calls** go through `client/src/utils/api.js`. Never raw `fetch`/`axios`.
- **CSS**: reuse existing classes (`hstack`, `spacer`, `tiny`, `muted`, `btn`, `btn-sm`), all verified present in `client/src/index.css` under the `admin-os` scope. No new CSS.
- **Before any commit touching `client/`**: `cd client && CI=true npx react-scripts build`. It is the only local gate that catches CI-fatal ESLint warnings, and `.husky/pre-push` runs it too.
- **Option-group collapse stays client-side and may straddle a page.** Accepted in the spec. Do not "fix" it by touching the list SQL.

## Lane map

```yaml
lanes:
  - id: prop-pagination
    footprint:
      - client/src/pages/admin/ProposalsDashboard.js
    depends_on: []
    review_fleet: [code-review]
```

**One lane, two tasks, sequential** (1 → 2): task 2's control renders state that task 1 creates.

**Commit unit:** both tasks commit inside the lane as checkpoints. The squash merge is the unit that reaches `main`, so neither commit lands on `main` on its own and CLAUDE.md's one-commit-per-logical-feature rule is satisfied by the squash, not by the checkpoints.

**Review checkpoint:** `code-review` fires once, after Task 2 Step 6, against the full lane diff. Task 1 alone is behavior-inert (it changes what the request carries but ships no control), so reviewing it in isolation buys nothing.

**Review level: light look, not the full fleet.** Verified 2026-08-12 with
`node scripts/sensitive-match.js client/src/pages/admin/ProposalsDashboard.js`,
which exits 1 (no match; `server/utils/clientNotices.js` exits 0 as a control).
No money, auth, webhook, or schema surface is touched. The push-time integration
sweep still applies as normal.

---

### Task 1: Page state, query wiring, and filter reset

**Files:**
- Modify: `client/src/pages/admin/ProposalsDashboard.js`

**Interfaces:**
- Produces, for Task 2: `PAGE_SIZE` (module constant, `50`), `page` (derived number, >= 1), and `setListState`, used directly for page writes.
- **`pageCount` is NOT created here.** Task 2 Step 1 declares it. Do not add it in this task, or Task 2 redeclares the same `const` and the build fails.

- [ ] **Step 1: Add `page` to the URL defaults and a `PAGE_SIZE` constant**

At `:53`, extend `LIST_DEFAULTS`. `useUrlListState` omits values equal to the default, so page 1 keeps the URL at `/proposals` and only page 2+ writes `?page=2`. `clearFilters` already does `setListState(LIST_DEFAULTS)`, so adding the key here makes Clear reset the page for free.

```js
// Server page size. Sent explicitly as `limit` rather than leaning on the
// server's default, so pageCount here can never silently disagree with the
// number of rows the server actually returns.
const PAGE_SIZE = 50;
// View state lives in the URL (admin cross-nav): every control writes through
// setListState so drill-outs are plain links and Back restores the filters.
// `page` is URL state too, so Back and a refresh land on the page you were on.
const LIST_DEFAULTS = { tab: 'active', q: '', source: '', from: '', to: '', axis: 'event', status: '', event_type: '', balance: '', cohort: '', page: '1' };
```

- [ ] **Step 2: Derive `page` and add the `setFilters` wrapper**

Immediately after the existing `cohort` derivation (`:70`), add the page derivation. Then add `setFilters` next to it.

```js
  const page = Math.max(1, parseInt(listState.page, 10) || 1);
  // Every filter/tab/sort write goes through setFilters, never setListState:
  // changing the filtered set while sitting on page 4 would otherwise drop you
  // on an empty table. The pager buttons are the only legitimate page writer.
  const setFilters = useCallback((patch) => setListState({ ...patch, page: '1' }), [setListState]);
```

- [ ] **Step 3: Route every filter write through `setFilters`**

Replace `setListState` with `setFilters` at exactly these fourteen call sites, and nowhere else. Line numbers are pre-edit; match on the surrounding code, not the number.

| Line | Control |
|---|---|
| `:214` | `applyPreset`, the `'all'` branch |
| `:219` | `applyPreset`, the `'custom'` seed |
| `:225` | `applyPreset`, a named preset |
| `:234` | `toggleStatus` |
| `:237` | `clearFilters` |
| `:261` | `Toolbar` `setTab` |
| `:270` | Source `<select>` |
| `:301` | From date input |
| `:310` | To date input |
| `:320` | Axis, Event date |
| `:328` | Axis, Sent |
| `:353` | Event type `<select>` |
| `:366` | Open balance toggle |
| `:376` | Clear cohort |

Leave the `useUrlListState` call at `:66` alone.

- [ ] **Step 4: Reset the page on sort**

Sort is ephemeral state rather than URL state, so it needs the reset explicitly. Replace the `onSort` callback, which **begins at `:78`**. Do not touch `:77`, which is `const [sort, setSort] = useState(null);`; a literal replace starting there deletes the sort state.

```js
  const onSort = useCallback((key) => {
    setSort(prev => (prev && prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' }));
    // Re-sorting reorders the whole filtered set server-side, so page 4 of the
    // old order is meaningless in the new one.
    setListState({ page: '1' });
  }, [setListState]);
```

- [ ] **Step 5: Send `page` and `limit` on the request**

In the `queryString` memo, after the `sort`/`dir` block and before `return p.toString()`:

```js
    p.set('limit', String(PAGE_SIZE));
    if (page > 1) p.set('page', String(page));
```

Then add `page` to the memo's dependency array (`PAGE_SIZE` is a module constant and does not belong there):

```js
  }, [cohort, listState.status, listState.q, listState.from, listState.to,
    listState.event_type, listState.balance, axis, sourceFilter, tab, sort, page]);
```

`fetchProposals` already depends on `queryString`, so the existing effect refetches on a page change with no new effect.

- [ ] **Step 6: Verify by hand before there is a control**

Start the dev server with `npm run dev` from the repo root if it is not already running. Client edits hot-reload under CRA, so the project's usual "restart the managed dev server after an edit" rule does not apply to this change; it applies to server edits only. Sign in as admin and open `/proposals`.

1. Note the first client name in the table.
2. Open devtools Network, reload, and find the `/api/proposals?...` request. Expected: the query string contains `limit=50`, and the response carries 50 rows. This is the only check that the Global Constraint on explicit `limit` actually holds; without it, dropping Step 5's `p.set('limit', ...)` would pass every other step in this plan, because the server's default is also 50.
3. Edit the URL to `/proposals?page=2` and press Enter.
4. Expected: a different set of rows, and the footer still reads `219 proposals · showing first 50` (the old footer, unchanged until Task 2).
5. Click the Draft tab. Expected: the URL loses `?page=2` and the table shows Draft rows, not an empty table.
6. Back to `/proposals?page=2`, then click the Total column header. Expected: `?page=2` disappears from the URL and the table re-sorts from the top.

If step 5 or 6 leaves `?page=2` in the URL, a call site in Step 3 was missed.

- [ ] **Step 7: Lint gate and hook suite**

Run: `cd client && CI=true npx react-scripts build`
Expected: `Compiled successfully.` Any ESLint warning is CI-fatal and must be fixed here, most likely an exhaustive-deps warning on `onSort` or `queryString`.

Then run the hook suite, because Step 1 is what makes `useUrlListState`'s default-omission behavior load-bearing:

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/hooks/useUrlListState.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/admin/ProposalsDashboard.js
git commit -m "feat(proposals): page number in URL state, reset on every filter change"
```

---

### Task 2: The pager control and the stale-page guard

**Files:**
- Modify: `client/src/pages/admin/ProposalsDashboard.js`

**Interfaces:**
- Consumes from Task 1: `PAGE_SIZE`, `page`, `setListState`, plus the existing `total` state (`:63`) and `loading` (`:65`).

> **Line anchors in this task are pre-Task-1 numbers.** Task 1 inserts roughly a dozen lines above every one of them, so by the time this task runs the footer block sits near `:487` rather than `:475`. Match on the surrounding code, never on the number.

- [ ] **Step 1: Derive `pageCount`**

Add next to the `page` derivation from Task 1:

```js
  // total is the unpaginated count from X-Total-Count. Floor at 1 so an empty
  // result still reads "Page 1 of 1" rather than "of 0".
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
```

- [ ] **Step 2: Add the stale-page guard**

Place it after the `useEffect(() => { fetchProposals(); }, [fetchProposals]);` line (pre-Task-1 `:149`).

```js
  // Archive a proposal while sitting on the last page, refresh, and the server
  // hands back an empty page for a page that no longer exists. Snap to the last
  // page that does. Guarded on total > 0 so a genuinely empty filter result is
  // left alone, and it terminates because pageCount is always < page when it
  // fires.
  useEffect(() => {
    if (!loading && total > 0 && page > pageCount) {
      setListState({ page: String(pageCount) });
    }
  }, [loading, total, page, pageCount, setListState]);
```

- [ ] **Step 3: Replace the footer**

Replace the whole `{!loading && (...)}` footer block (pre-Task-1 `:475-480`, and see the anchor note above):

```jsx
      {!loading && (
        <div className="hstack tiny muted" style={{ padding: '8px 2px' }}>
          <span>
            {pageCount > 1 ? `Page ${page} of ${pageCount} · ` : ''}
            {`${total} ${total === 1 ? 'proposal' : 'proposals'} · Click a row to open`}
          </span>
          {pageCount > 1 && (
            <>
              <div className="spacer" />
              <nav className="hstack" aria-label="Proposal pages">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={page <= 1}
                  onClick={() => setListState({ page: String(page - 1) })}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={page >= pageCount}
                  onClick={() => setListState({ page: String(page + 1) })}
                >
                  Next
                </button>
              </nav>
            </>
          )}
        </div>
      )}
```

The label is a page counter, not a `51-100 of 219` row range, and that is deliberate: the option-group rollup at `:164` collapses siblings in the browser, so a 50-row fetch can render 47 rows and a row range would contradict the table. Note also that the old `showing first N` clause is gone; the page counter replaces it.

- [ ] **Step 4: Lint gate**

Run: `cd client && CI=true npx react-scripts build`
Expected: `Compiled successfully.`

- [ ] **Step 5: Re-run the hook suite**

Same suite as Task 1 Step 7, re-run because this task adds two more `setListState` writers (the Prev/Next buttons and the stale-page guard):

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/hooks/useUrlListState.test.js`
Expected: PASS.

- [ ] **Step 6: Browser walk**

On `/proposals`, signed in as admin:

1. Active tab: expect `Page 1 of 5 · 219 proposals · Click a row to open`, Prev disabled, Next enabled. (The exact counts will differ if prod data has moved; what matters is that `pageCount` equals `ceil(total / 50)`.)
2. Click Next to page 2. Expect the URL to gain `?page=2`, the rows to change, and Prev to enable.
3. Page to the last page. Expect Next to disable and the row count to be fewer than 50. Do not expect an exact remainder: the option-group rollup can collapse a few of the fetched rows away.
4. From page 3, click a proposal row to open it, then press Back. Expect to return to **page 3**, not page 1. This is the Back that matters and the reason page lives in the URL. Note that Back does NOT step backwards through pages: `useUrlListState` writes with `replace: true`, so paging creates no history entries, exactly like flipping a filter today.
5. From page 3, click the Draft tab. Expect page 1 of Draft with rows visible.
6. Pick a tab with fewer than 50 rows. Expect no Prev/Next at all and a footer identical to today's (`40 proposals · Click a row to open`).
7. From page 2, click the Total column header. Expect the URL to drop `?page=2`, the table to re-sort from the top, and Prev to be disabled again. (Task 1 Step 6 walked this before the control existed; this confirms it with the control.)
8. Visit `/proposals?page=99` directly. Expect a briefly empty table, then a snap back to the last real page once the fetch resolves and the guard fires. A momentary empty state is correct, a persistent one is not.
9. Apply a filter that matches nothing (for example the Draft tab plus an event type no draft uses). Expect an empty table, the pager absent, and **no URL churn**: the guard's `total > 0` gate is what keeps a zero-result view from looping, and this is the only step that exercises that branch.

Note on step 2 and 3: the pager lives inside the existing `{!loading && ...}` wrapper, so Prev/Next unmount briefly during each fetch. That flicker is pre-existing footer behavior, not a defect introduced here.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/admin/ProposalsDashboard.js
git commit -m "feat(proposals): Prev/Next pager with stale-page guard"
```

---

## Self-review notes

**Spec coverage.** Page in the URL: Task 1 Steps 1 and 5. Query builder: Task 1 Step 5. Filter reset: Task 1 Steps 2, 3, 4. The control: Task 2 Step 3. Stale-page guard: Task 2 Step 2. Verification: Task 1 Step 7, Task 2 Steps 4, 5, 6. Events/shifts explicitly out of footprint. Option-group straddle accepted, restated as a Global Constraint so no implementer "fixes" it.

**Two deliberate deviations from the spec**, both disclosed here rather than smuggled:

1. The spec did not say to send `limit` explicitly; it assumed the server default of 50. Sending it makes the client's `pageCount` arithmetic and the server's actual page size agree by construction instead of by coincidence. One line, no behavior change today. Verified at Task 1 Step 6 item 2.
2. The spec's stale-page guard triggers on "rows come back empty and page is above 1". This plan triggers on `total > 0 && page > pageCount` instead. It is strictly more robust: it fires off the authoritative count rather than off an empty render, it cannot be confused by an option-group collapse, and it provably terminates because `pageCount < page` whenever it fires. The spec's version would also work; this one is better, and the difference is behavioral, so it is called out.

**Review-fleet findings folded in (2026-08-12).** Plan fleet returned 0 blockers. Corrected: the `onSort` anchor (`:78`, not `:77`, where `:77` is the sort state declaration and a literal replace would have deleted it), `loading` (`:65`), the fetch effect (`:149`), and Task 2's anchors are now flagged as pre-Task-1. Task 1's Interfaces block no longer claims to produce `pageCount`, which would have caused a duplicate `const`. Added checkpoints for the explicit `limit=50`, the guard's zero-result branch, and the sort reset with the control present. One fleet finding was **rejected**: the claim that the new footer drops `showing first N` on single-page views is wrong, because that clause keys on `proposals.length` (rows fetched), not the collapsed `rows` the table renders, so on any tab under 50 it never fires today either.

**Names used consistently:** `PAGE_SIZE`, `page`, `pageCount`, `setFilters`, `setListState`, `total`, `loading` are spelled the same in both tasks.
