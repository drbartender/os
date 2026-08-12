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
- Produces, for Task 2: `PAGE_SIZE` (module constant, `50`), `page` (derived number, >= 1), `pageCount` (derived number, >= 1), and `setListState` used directly for page writes.

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

Sort is ephemeral state rather than URL state, so it needs the reset explicitly. Replace `onSort` at `:77`:

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

Start the dev server if it is not already running, sign in as admin, and open `/proposals`.

1. Note the first client name in the table.
2. Edit the URL to `/proposals?page=2` and press Enter.
3. Expected: a different set of rows, and the footer still reads `219 proposals · showing first 50` (the old footer, unchanged until Task 2).
4. Click the Draft tab. Expected: the URL loses `?page=2` and the table shows Draft rows, not an empty table.
5. Back to `/proposals?page=2`, then click the Total column header. Expected: `?page=2` disappears from the URL and the table re-sorts from the top.

If step 4 or 5 leaves `?page=2` in the URL, a call site in Step 3 was missed.

- [ ] **Step 7: Lint gate**

Run: `cd client && CI=true npx react-scripts build`
Expected: `Compiled successfully.` Any ESLint warning is CI-fatal and must be fixed here, most likely an exhaustive-deps warning on `onSort` or `queryString`.

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
- Consumes from Task 1: `PAGE_SIZE`, `page`, `setListState`, plus the existing `total` state (`:63`) and `loading` (`:64`).

- [ ] **Step 1: Derive `pageCount`**

Add next to the `page` derivation from Task 1:

```js
  // total is the unpaginated count from X-Total-Count. Floor at 1 so an empty
  // result still reads "Page 1 of 1" rather than "of 0".
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
```

- [ ] **Step 2: Add the stale-page guard**

Place it after the `useEffect(() => { fetchProposals(); }, [fetchProposals]);` line at `:148`.

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

Replace the whole `{!loading && (...)}` footer block at `:475-480`:

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

- [ ] **Step 5: Run the hook suite**

This change makes `useUrlListState`'s default-omission behavior load-bearing for keeping the URL clean on page 1, so run its suite:

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/hooks/useUrlListState.test.js`
Expected: PASS.

- [ ] **Step 6: Browser walk**

On `/proposals`, signed in as admin:

1. Active tab: expect `Page 1 of 5 · 219 proposals · Click a row to open`, Prev disabled, Next enabled. (The exact counts will differ if prod data has moved; what matters is that `pageCount` equals `ceil(total / 50)`.)
2. Click Next to page 2. Expect the URL to gain `?page=2`, the rows to change, and Prev to enable.
3. Page to the last page. Expect Next to disable and the row count to be the remainder, not 50.
4. From page 3, click a proposal row to open it, then press Back. Expect to return to **page 3**, not page 1. This is the Back that matters and the reason page lives in the URL. Note that Back does NOT step backwards through pages: `useUrlListState` writes with `replace: true`, so paging creates no history entries, exactly like flipping a filter today.
5. From page 3, click the Draft tab. Expect page 1 of Draft with rows visible.
6. Pick a tab with fewer than 50 rows. Expect no Prev/Next at all and a footer identical to today's.
7. Visit `/proposals?page=99` directly. Expect it to snap back to the last real page rather than showing an empty table.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/admin/ProposalsDashboard.js
git commit -m "feat(proposals): Prev/Next pager with stale-page guard"
```

---

## Self-review notes

**Spec coverage.** Page in the URL: Task 1 Steps 1 and 5. Query builder: Task 1 Step 5. Filter reset: Task 1 Steps 2, 3, 4. The control: Task 2 Step 3. Stale-page guard: Task 2 Step 2. Verification: Task 1 Step 7, Task 2 Steps 4, 5, 6. Events/shifts explicitly out of footprint. Option-group straddle accepted, restated as a Global Constraint so no implementer "fixes" it.

**One deliberate addition beyond the spec.** The spec did not say to send `limit` explicitly; it assumed the server default of 50. Sending it makes the client's `pageCount` arithmetic and the server's actual page size agree by construction instead of by coincidence. One line, no behavior change today.

**Names used consistently:** `PAGE_SIZE`, `page`, `pageCount`, `setFilters`, `setListState`, `total`, `loading` are spelled the same in both tasks.
