# Clickable Row with Text Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins highlight and copy text from the proposals list view while preserving "click anywhere on a row to open the proposal."

**Architecture:** Replace the proposals-row `onClick` handler with an intent-detecting `ClickableRow` component. At mouseup, four gates (drag threshold, active selection, interactive-child target, modifier keys) decide whether to navigate, open in a new tab, or do nothing.

**Tech Stack:** React 18, React Router 6. No test runner in the frontend — verification is manual browser checks. No backend, schema, or API changes.

**Project conventions to honor:**
- **Git:** Trunk-only, explicit file staging (`git add <path>`), commit cue required before commits, push cue required separately (not in this plan).
- **Docs:** Adding a new component requires updating `.claude/CLAUDE.md` and `README.md` folder trees in the same change (per the Mandatory Documentation Updates table in CLAUDE.md).

---

## File Structure

| File | Action | Purpose |
|---|---|---|
| `client/src/components/ClickableRow.js` | Create | Reusable `<tr>` wrapper that navigates on click but yields to text selection |
| `client/src/pages/admin/ProposalsDashboard.js` | Modify | Swap `<tr onClick={...}>` for `<ClickableRow to={...}>`; remove redundant `stopPropagation` on Copy Link button |
| `.claude/CLAUDE.md` | Modify | Add `ClickableRow.js` to the `client/src/components/` folder tree in alphabetical order |
| `README.md` | Modify | Add `ClickableRow` to the one-line components list |

No other files touched. No backend, schema, route, or env changes.

---

## Task 1: Build ClickableRow and wire it into ProposalsDashboard

**Files:**
- Create: `client/src/components/ClickableRow.js`
- Modify: `client/src/pages/admin/ProposalsDashboard.js` (row definition at line 118; Copy Link button at lines 133–138)

**Intent:** One commit produces a working, testable change. The component and its first consumer ship together so the commit is "finished, tested work" per the project's Rule 3.

- [ ] **Step 1: Create the `ClickableRow` component**

Create `client/src/components/ClickableRow.js` with this exact content:

```jsx
import React, { useRef } from 'react';
import { useNavigate } from 'react-router-dom';

const DRAG_THRESHOLD_PX = 4;
const INTERACTIVE_SELECTOR = 'button, a, input, select, textarea, [role="button"]';

export default function ClickableRow({ to, children, style, ...rest }) {
  const navigate = useNavigate();
  const pressRef = useRef(null);

  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    pressRef.current = { x: e.clientX, y: e.clientY };
  };

  const onMouseUp = (e) => {
    const start = pressRef.current;
    pressRef.current = null;
    if (!start || e.button !== 0) return;

    const dx = Math.abs(e.clientX - start.x);
    const dy = Math.abs(e.clientY - start.y);
    if (dx > DRAG_THRESHOLD_PX || dy > DRAG_THRESHOLD_PX) return;

    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;

    if (e.target.closest(INTERACTIVE_SELECTOR)) return;

    if (e.ctrlKey || e.metaKey) {
      window.open(to, '_blank', 'noopener,noreferrer');
      return;
    }

    navigate(to);
  };

  const onAuxClick = (e) => {
    if (e.button === 1) {
      e.preventDefault();
      window.open(to, '_blank', 'noopener,noreferrer');
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') navigate(to);
  };

  return (
    <tr
      {...rest}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onAuxClick={onAuxClick}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="link"
      style={{ cursor: 'pointer', ...style }}
    >
      {children}
    </tr>
  );
}
```

Why each bit exists:
- `useRef` holds mousedown coords per-instance. Survives re-renders, doesn't trigger them.
- `DRAG_THRESHOLD_PX = 4` is calibrated to tolerate trackpad jitter on a click while catching any intentional drag.
- `INTERACTIVE_SELECTOR` covers every element type that should handle its own click. Replaces per-child `stopPropagation`.
- `{...rest}` is spread *before* our handlers so a consumer can't accidentally override the navigation handlers.
- `noopener,noreferrer` on `window.open` is the standard security-safe pattern.
- `tabIndex={0}` + `role="link"` + `onKeyDown` preserve a11y from the original implementation.

- [ ] **Step 2: Swap the `<tr>` in `ProposalsDashboard.js`**

Open `client/src/pages/admin/ProposalsDashboard.js`.

Add the import at the top of the file (after the existing imports, around line 3):

```jsx
import ClickableRow from '../../components/ClickableRow';
```

Replace lines 118–140 (the `<tr>` through the closing `</tr>`, but keep each `<td>` unchanged). The starting `<tr ...>` opening tag becomes `<ClickableRow ...>` and the closing `</tr>` becomes `</ClickableRow>`.

Specifically, find this block:

```jsx
<tr key={p.id} onClick={() => navigate(`/admin/proposals/${p.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/admin/proposals/${p.id}`)} tabIndex={0} role="link" style={{ cursor: 'pointer' }}>
  <td>
    <strong>{p.client_name && p.event_name ? `${p.client_name} - ${p.event_name}` : p.client_name || '—'}</strong>
    {p.client_email && <div className="text-muted text-small">{p.client_email}</div>}
  </td>
  <td>{p.event_name || '—'}</td>
  <td>{formatDate(p.event_date)}</td>
  <td>{p.package_name || '—'}</td>
  <td style={{ fontWeight: 600 }}>{formatCurrency(p.total_price)}</td>
  <td>
    <span className={`badge ${STATUS_CLASSES[p.status] || ''}`}>
      {STATUS_LABELS[p.status] || p.status}
    </span>
  </td>
  <td>
    <button
      className="btn btn-sm btn-secondary"
      onClick={(e) => { e.stopPropagation(); copyLink(p.token); }}
    >
      {copyMessage === p.token ? 'Copied!' : 'Copy Link'}
    </button>
  </td>
</tr>
```

Replace with:

```jsx
<ClickableRow key={p.id} to={`/admin/proposals/${p.id}`}>
  <td>
    <strong>{p.client_name && p.event_name ? `${p.client_name} - ${p.event_name}` : p.client_name || '—'}</strong>
    {p.client_email && <div className="text-muted text-small">{p.client_email}</div>}
  </td>
  <td>{p.event_name || '—'}</td>
  <td>{formatDate(p.event_date)}</td>
  <td>{p.package_name || '—'}</td>
  <td style={{ fontWeight: 600 }}>{formatCurrency(p.total_price)}</td>
  <td>
    <span className={`badge ${STATUS_CLASSES[p.status] || ''}`}>
      {STATUS_LABELS[p.status] || p.status}
    </span>
  </td>
  <td>
    <button
      className="btn btn-sm btn-secondary"
      onClick={() => copyLink(p.token)}
    >
      {copyMessage === p.token ? 'Copied!' : 'Copy Link'}
    </button>
  </td>
</ClickableRow>
```

Two things changed beyond the tag swap:
- The inline `onClick`, `onKeyDown`, `tabIndex`, `role`, and `style` are gone — `ClickableRow` owns all of these.
- The Copy Link button's `stopPropagation` is removed. The interactive-child guard in `ClickableRow`'s `onMouseUp` handles it (the button is matched by `INTERACTIVE_SELECTOR`).

- [ ] **Step 3: If `navigate` is no longer used elsewhere, clean up the unused import**

Check `ProposalsDashboard.js` for remaining `navigate(` calls. There is one at the top of the return: `onClick={() => navigate('/admin/proposals/new')}` in the "+ New Proposal" button. So `navigate` and `useNavigate` are still used. **Leave both imports alone.** Do not remove them.

(Step included defensively — the swap could have orphaned an import. Confirm and move on.)

- [ ] **Step 4: Start the dev server if it isn't already running**

Run in a separate terminal:

```bash
npm run dev
```

Expected: Express starts on `:5000`, React on `:3000`, opens the browser automatically.

If it's already running, skip.

- [ ] **Step 5: Manual browser verification — run the full behavioral matrix**

Log in as admin, navigate to `http://localhost:3000/admin/proposals`. Confirm the list is populated (if empty, seed test data first with whatever mechanism the project uses; the behavior can't be verified on an empty list).

Execute this checklist exactly. Every line must pass:

| # | Action | Expected |
|---|---|---|
| 1 | Single left-click anywhere on a row (no drag) | Navigates to that proposal |
| 2 | Back to list. Drag across a client email | Email text is highlighted. No navigation. Cmd/Ctrl+C copies the email |
| 3 | Double-click on a client name | Word is selected. No navigation |
| 4 | Triple-click on a cell value | Line/cell text is selected. No navigation |
| 5 | Drag from one row's email down through another row's total | Range across rows is highlighted. No navigation |
| 6 | Cmd+click (macOS) or Ctrl+click (Windows) on a row | Proposal opens in a new browser tab. Current tab unchanged |
| 7 | Middle-click (mouse wheel button) on a row | Proposal opens in a new browser tab |
| 8 | Right-click on a row | Browser context menu appears. No navigation |
| 9 | Click "Copy Link" button on a row | Shows "Copied!" text. Link is on clipboard. No navigation |
| 10 | Tab key until a row is focused, then press Enter | Navigates to that proposal |
| 11 | Visually compare row hover state to before | Unchanged — same background, same cursor (pointer) |
| 12 | Start a selection in one row, then click a different row that has no selected text | First click clears the selection (native browser), second click navigates (acceptable per spec) |

If any row fails: stop, report the failure, and debug before committing.

- [ ] **Step 6: Report verification results to user and wait for commit cue**

Summarize: "All 12 checks passed" (or list failures). Do not commit yet. Per project Rule 4, wait for an explicit cue like "looks good", "commit", or "next task."

- [ ] **Step 7: On commit cue, stage exactly these two files and commit**

```bash
git add client/src/components/ClickableRow.js client/src/pages/admin/ProposalsDashboard.js
git commit -m "$(cat <<'EOF'
feat(admin): add ClickableRow for proposals list with drag-to-select

Swap the inline onClick row handler for a reusable ClickableRow component
that detects user intent at mouseup. Short click navigates; drag selects
text; cmd/ctrl+click and middle-click open in a new tab; interactive
children (Copy Link) handle their own clicks via a built-in guard.

Also removes the now-redundant stopPropagation on the Copy Link button.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Do not push. Pushing requires a separate push cue.

---

## Task 2: Update folder-tree documentation

**Files:**
- Modify: `.claude/CLAUDE.md` (around line 89 in the `client/src/components/` section of the folder tree)
- Modify: `README.md` (line 151, the one-line components list)

**Intent:** A new component requires both docs to list it, per the Mandatory Documentation Updates table in CLAUDE.md. Docs-only, behavior-inert commit.

- [ ] **Step 1: Add `ClickableRow.js` to the `CLAUDE.md` folder tree**

Open `.claude/CLAUDE.md`. Find the block under `client/src/components/` that lists files in alphabetical order — it starts with `AdminLayout.js` and includes `BrandLogo.js`, `ConfirmModal.js`, etc.

Insert this line in alphabetical order (between `BrandLogo.js` and `ConfirmModal.js`):

```
│   │   │   ├── ClickableRow.js   # <tr> wrapper: click navigates, drag selects text
```

Match the existing indentation and tree-character style (`│   │   │   ├──`) exactly — tree drawing characters must line up visually with the surrounding entries.

- [ ] **Step 2: Add `ClickableRow` to the `README.md` components summary line**

Open `README.md`. Find line 151:

```
│   │   ├── components/         # Layout, InvoiceDropdown, SignaturePad, FileUpload, PricingBreakdown, RichTextEditor,
│   │   │                       # LeadImportModal, AudienceSelector, SequenceStepEditor, CampaignMetricsBar,
│   │   │                       # SyrupPicker
```

Add `ClickableRow` to the list. Insert it at a natural spot — between `SignaturePad` and `FileUpload` is fine, or append to the last line before `SyrupPicker`. Preferred:

```
│   │   ├── components/         # Layout, InvoiceDropdown, SignaturePad, ClickableRow, FileUpload, PricingBreakdown,
│   │   │                       # RichTextEditor, LeadImportModal, AudienceSelector, SequenceStepEditor,
│   │   │                       # CampaignMetricsBar, SyrupPicker
```

Preserve the leading tree-drawing characters and column alignment. The comment block must remain visually aligned in monospaced display.

- [ ] **Step 3: Confirm no ARCHITECTURE.md update is needed**

Per the Mandatory Documentation Updates table in CLAUDE.md, a new *component* (row: "New/removed component") has `—` in the ARCHITECTURE.md column. **Do not touch ARCHITECTURE.md.**

Skipping this step in silence would drift from the table; calling it out here is the record that it was checked.

- [ ] **Step 4: Report and wait for commit cue**

Show the user the two diffs. State: "Docs updated to match new component. Ready to commit when you give the cue."

- [ ] **Step 5: On commit cue, stage exactly these two files and commit**

```bash
git add .claude/CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
docs: list ClickableRow in folder trees

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Do not push.

---

## Post-Implementation Notes

- **Push is out of scope** for this plan. When the user gives a push cue, the project's Pre-Push Procedure (Rule 6) runs the 5 review agents in parallel. Expect `consistency-check` to verify the docs changes, `code-review` to check the new component, and the others to pass silently.
- **EventsDashboard is explicitly not touched.** Per prior conversation the user wants events to stay as cards, separate from proposals.
- **If `/admin/proposals` is empty in your test environment,** the behavior cannot be fully verified. Seed data (`npm run seed` or similar) or create a proposal via the UI first.
