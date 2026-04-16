# Clickable Row with Text Selection

**Date:** 2026-04-16
**Scope:** Admin UI — `ProposalsDashboard` list view
**Motivation:** The row-level `onClick` in the proposals table swallows drag-to-select, so admins can't highlight and copy a client email, phone number, or cell value out of the list. We want to keep the "click anywhere on a row opens the proposal" feel while restoring native text selection.

---

## Goals

- Clicking a row still navigates to the proposal detail page.
- Dragging within or across rows selects text instead of navigating.
- Double-click (word select) and triple-click (line select) behave natively — no navigation.
- Cmd/Ctrl+click and middle-click open the proposal in a new tab (currently broken).
- Keyboard behavior (`Enter` to activate, `Tab` to focus) is unchanged.
- Solution is reusable — any future table row can adopt it with a one-line swap.

## Non-Goals

- No changes to EventsDashboard (still cards; separate conversation).
- No visual or layout changes to the proposals list.
- No multi-row checkbox selection UI. Drag-select across rows is enough for occasional range copies.

---

## Design

### Core mechanic — intent detection at mouseup

Replace `onClick` with `onMouseDown` + `onMouseUp`. At mouseup, four gates decide whether to navigate, in order:

1. **Drag threshold.** Record `(clientX, clientY)` at mousedown. If either axis moved more than `4px` by mouseup, treat as a drag — don't navigate. This handles both single-field highlight and multi-row range selection.
2. **Active text selection.** If `window.getSelection().toString().length > 0` at mouseup, don't navigate. Covers double-click (word) and triple-click (line) without special casing.
3. **Interactive child guard.** If the event target is inside a `button`, `a`, `input`, `select`, `textarea`, or `[role="button"]`, don't navigate. The child handles its own click. Replaces the per-button `stopPropagation` calls used today.
4. **Modifier keys.** Cmd/Ctrl+click → `window.open(to, '_blank')` instead of in-tab navigation. Middle-click via `onAuxClick` → same. These are standard web behaviors the current `onClick` silently swallows.

If all gates pass, call `navigate(to)`.

Only respond to left-button events (`e.button === 0`) for mousedown/up; right-clicks open the browser context menu naturally and are ignored.

### Keyboard and accessibility

Preserved exactly as today:

- `tabIndex={0}` on the row.
- `role="link"` on the row.
- `onKeyDown` handler that navigates on `Enter`.

Screen readers continue to announce the row as a link. No ARIA changes.

### Component shape

New file: `client/src/components/ClickableRow.js`

A thin wrapper over `<tr>` that takes a `to` prop (the navigate path) plus any standard `tr` props (`className`, `children`, etc.). It owns the mousedown/up/auxclick/keydown handlers internally and uses a `useRef` to hold the mousedown coordinates (per-instance, survives re-renders, zero perf cost in a list).

Call site transformation in `ProposalsDashboard.js`:

```jsx
// Before
<tr
  key={p.id}
  onClick={() => navigate(`/admin/proposals/${p.id}`)}
  onKeyDown={(e) => e.key === 'Enter' && navigate(`/admin/proposals/${p.id}`)}
  tabIndex={0}
  role="link"
  style={{ cursor: 'pointer' }}
>

// After
<ClickableRow key={p.id} to={`/admin/proposals/${p.id}`}>
```

### Cleanup in the same change

- Remove the `onClick={(e) => { e.stopPropagation(); ... }}` pattern on the "Copy Link" button. The interactive-child guard in gate 3 makes `stopPropagation` unnecessary.

---

## Behavioral matrix

| User action on a row | Outcome |
|---|---|
| Plain left-click (no drag, no existing selection) | Navigate to proposal |
| Left-click + drag within a cell | Select text within cell, no navigation |
| Left-click + drag across cells or rows | Select range, no navigation |
| Double-click on text | Browser selects word, no navigation |
| Triple-click on text | Browser selects line, no navigation |
| Cmd/Ctrl + left-click | Open proposal in new tab |
| Middle-click (button 1) | Open proposal in new tab |
| Right-click | Browser context menu (copy, inspect, etc.), no navigation |
| `Tab` to row, `Enter` | Navigate to proposal |
| Click on "Copy Link" button | Copy link, no navigation (interactive-child guard) |

---

## Edge cases and decisions

- **4px threshold.** Chosen to tolerate incidental mouse jitter on click (common on trackpads and touch-mice) while catching even the shortest intentional drags. Not configurable — single constant in the component.
- **Cursor style.** Keep `cursor: pointer` on the row. Text still selects despite the pointer cursor; the inconsistency is less jarring than a text cursor on a clickable row.
- **Existing selection before click.** If text is already selected elsewhere on the page and the user clicks a row, gate 2 will prevent navigation because `getSelection().toString()` is non-empty. This is acceptable — the first click clears the selection (via the browser's native behavior on mousedown), and the second click navigates. A rare case; not worth special handling.
- **Touch devices.** Mobile taps register as mousedown+mouseup with no movement, so gate 1 passes and navigation works. Drag-select is not a meaningful mobile gesture, so no special handling is needed.
- **Per-row closure.** `useRef` is scoped to each `ClickableRow` instance, so mousedown state from row A cannot leak into mouseup on row B.

---

## Out-of-scope but enabled

- **EventsDashboard conversion.** If events are eventually converted from cards to a table, `ClickableRow` is a drop-in. No follow-up design needed for that swap.
- **Other admin list views.** Same drop-in applies (ClientsDashboard, DrinkPlansDashboard, etc.) if/when they get the same treatment.

---

## Testing plan

Manual verification in the browser on `/admin/proposals`:

1. Click anywhere on a row → navigates to that proposal.
2. Drag across a client email → email is selected, can copy with Cmd/Ctrl+C, no navigation fires.
3. Double-click on a client name → word selected, no navigation.
4. Drag from one row's email down into another row's total → range selected, no navigation.
5. Cmd/Ctrl+click a row → opens proposal in new tab, current tab unchanged.
6. Middle-click a row → opens proposal in new tab.
7. Right-click a row → context menu appears, no navigation.
8. Click "Copy Link" button → link copied, no navigation.
9. Tab to a row, press Enter → navigates.
10. Verify hover state and `cursor: pointer` are unchanged visually.

No automated tests; the project does not have a UI test harness for this flow.

---

## Cross-cutting impact

- **CLAUDE.md / README.md folder tree:** Adds `client/src/components/ClickableRow.js`. Both docs must list it.
- **ARCHITECTURE.md:** No change — it's a presentational component, not an architectural layer.
- **No schema, route, or API changes.** Frontend-only.
