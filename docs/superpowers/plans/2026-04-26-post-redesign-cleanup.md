# Post-Redesign Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This codebase has no automated test suite — substitute "manual verify in dev" for TDD ceremony. Each batch ends in a commit; pushes are user-initiated only.

**Goal:** Land 14 cleanup items from the post-redesign audit (theme leakage, missing density toggle, misleading function name, broken redirects, swallowed errors, no-op buttons, undefined CSS tokens, retire ShiftDetail, wire Events kebab) without touching the 9 deferred items reserved for the design agent.

**Architecture:** Trunk-only on `main`. Seven sequential batches, each shipping as one logical commit (some batches share a single commit, others split when the pieces are independently revertable). The Pre-Push Procedure runs the 5 review agents on each push. Each batch's manual verification step must pass before the commit.

**Tech Stack:** React 18 (CRA), Express 4, PostgreSQL via raw `pg`, vanilla CSS (~8500 lines in `client/src/index.css`, scoped to `html[data-app="admin-os"]` for admin shell), JWT auth, Stripe, Resend, Twilio.

**Spec:** `docs/superpowers/specs/2026-04-26-post-redesign-cleanup-design.md` — read before starting.

---

## Preflight

Run these once before starting Batch 1. Skip on resume.

- [ ] **Confirm branch.** Run: `git status`. Expected: `On branch main`. If not, stop and ask.
- [ ] **Inventory uncommitted changes.** Run: `git status`. The pre-existing modifications listed at session start (`LocationInput.js`, `index.css`, `ProposalCreate.js`) may still be there. Decide whether they belong in this work or should be stashed. Default: leave them untouched and only stage paths this plan modifies.
- [ ] **Start dev server (if not running).** Run: `npm run dev` in a separate terminal. Visit `http://localhost:3000`. Verify the admin login screen loads.
- [ ] **Sign in as admin** with seeded credentials (`npm run seed` if needed). Open `/admin/dashboard`. Confirm the admin shell renders.
- [ ] **Toggle the existing skin once** (current labels: Sterile / Experimental). Confirm both states render. Do NOT save anything yet.

---

## Batch 1 — Foundation (M1, C1, H12+L1+L2)

Three coupled mechanical changes: rename the misleadingly named formatter, stop leaking font tokens onto non-admin pages, and consolidate the skin naming. All commit-safe in any order; ship together because they touch related infrastructure files.

### Task 1.1 — M1: Rename `fmt$cents` → `fmt$2dp` and add `fmt$fromCents`

**Files:**
- Modify: `client/src/components/adminos/format.js`
- Modify (rename callsites): `client/src/pages/admin/ProposalCreate.js`, `client/src/components/adminos/drawers/EventDrawer.js`, `client/src/pages/admin/EventDetailPage.js`, `client/src/pages/admin/ProposalDetailPaymentPanel.js`, `client/src/pages/admin/FinancialsDashboard.js`, `client/src/pages/admin/ClientDetail.js`, `client/src/components/adminos/drawers/ClientDrawer.js`, `client/src/components/adminos/drawers/ProposalDrawer.js`

- [ ] **Step 1: Update `format.js`.** Replace the entire file contents. New contents:

```js
// Formatting helpers shared across Admin OS components.
// Money convention (per server/db/schema.sql:478-487):
//   - NUMERIC(10,2) DOLLARS:  proposals.total_price/amount_paid/deposit_amount,
//                             service_packages.*_rate/*_fee, service_addons.rate,
//                             proposal_addons.rate, etc.
//   - INTEGER CENTS:          stripe_sessions.amount, proposal_payments.amount,
//                             invoices.amount_due/amount_paid
// Use fmt$2dp for dollar fields, fmt$fromCents for cents fields.

export const fmt$ = (n) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

export const fmt$2dp = (n) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmt$fromCents = (n) =>
  n == null ? '—' : '$' + (Number(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtDate = (iso, opts = {}) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...opts });
};

export const fmtDateFull = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
};

export const dayDiff = (iso) => {
  if (!iso) return 0;
  const d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return 0;
  const t = new Date();
  t.setHours(12, 0, 0, 0);
  return Math.round((d - t) / 86400000);
};

export const relDay = (iso) => {
  const diff = dayDiff(iso);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 0) return `In ${diff}d`;
  return `${Math.abs(diff)}d ago`;
};
```

- [ ] **Step 2: Migrate callsites.** In each of the 8 files listed in the Files section above, find every `fmt$cents` (both the import and the usage) and replace with `fmt$2dp`. Quick script:

```bash
# From repo root, list every file containing fmt$cents (Windows / Git Bash):
grep -rl 'fmt\$cents' client/src/

# Then in each file: replace `fmt$cents` with `fmt$2dp` (both imports and call sites).
```

Use the editor's find/replace on each file individually — do NOT use a global sed/awk. Verify each diff visually.

- [ ] **Step 3: Verify no `fmt$cents` references remain.** Run:

```bash
grep -rn 'fmt\$cents' client/src/
```

Expected output: empty (no matches).

- [ ] **Step 4: Build check.** Run: `cd client && npm run build`. Expected: build succeeds with no warnings about undefined `fmt$cents`.

- [ ] **Step 5: Manual verify.** Open `http://localhost:3000/admin/proposals/new`. Walk through to a price total. Verify a price like `1500.00` renders as `$1,500.00` (two-decimal precision, dollar sign).

- [ ] **Step 6: Commit (defer until Task 1.3 done).** Do not commit yet; Tasks 1.1–1.3 commit together in Task 1.4.

---

### Task 1.2 — C1: Move font tokens out of inline `<html>` styles

**Files:**
- Modify: `client/src/context/UserPrefsContext.js`

- [ ] **Step 1: Read current file.** Open `client/src/context/UserPrefsContext.js`. Identify:
  - Lines 25-34: the `FONTS` constant with `dark` / `light` font sets
  - Lines 81-87: the `PROPS` array enumerating CSS custom properties to strip
  - Lines 121-125: the four `root.style.setProperty('--font-*', ...)` calls

- [ ] **Step 2: Delete the FONTS constant.** Remove lines 25-34 (the entire `const FONTS = { ... }` block).

- [ ] **Step 3: Remove font-property writes.** In the `useEffect` at lines 79-128, find this block (around line 121-125):

```js
const f = FONTS[prefs.skin] || FONTS.dark;
root.style.setProperty('--font-ui', f.ui);
root.style.setProperty('--font-display', f.display);
root.style.setProperty('--font-mono', f.mono);
root.style.setProperty('--font-numeric', f.numeric);
```

Delete it entirely.

- [ ] **Step 4: Strip font entries from PROPS.** Find the PROPS array (lines 81-87). Remove the four `'--font-*'` entries:

Before:
```js
const PROPS = [
  '--accent-h', '--accent-s', '--accent-l',
  '--ok-h', '--ok-s', '--warn-h', '--warn-s',
  '--danger-h', '--danger-s', '--info-h', '--info-s',
  '--violet-h', '--violet-s',
  '--font-ui', '--font-display', '--font-mono', '--font-numeric',
];
```

After:
```js
const PROPS = [
  '--accent-h', '--accent-s', '--accent-l',
  '--ok-h', '--ok-s', '--warn-h', '--warn-s',
  '--danger-h', '--danger-s', '--info-h', '--info-s',
  '--violet-h', '--violet-s',
];
```

- [ ] **Step 5: Verify CSS already defines fonts at the right scope.** Open `client/src/index.css`. Confirm:
  - Line ~6759-6762: dark-skin defaults define `--font-ui`, `--font-display`, `--font-mono`, `--font-numeric` inside `html[data-app="admin-os"]`
  - Line ~6855-6858: light-skin overrides define same vars inside `html[data-app="admin-os"][data-skin="light"]`

  No CSS edit needed — these are already correct. Just verify they exist.

- [ ] **Step 6: Manual verify (admin font swap still works).** With dev server running, visit `http://localhost:3000/admin/dashboard`. Open browser DevTools → Elements → inspect `<html>`. Confirm there are no inline `--font-*` properties in the `style=""` attribute. Then toggle skin (sidebar footer). Watch the page-title font swap from Inter (dark) ↔ Libre Caslon Text (light). Both fonts must apply on `.page-title` etc.

- [ ] **Step 7: Manual verify (no leak on public pages).** While logged in as admin in After Hours (dark) skin, navigate to `http://localhost:3000/` (public homepage). The homepage should render with its original public-site fonts, NOT Inter/Libre Caslon. Inspect `<html>` — no inline `--font-*` props. Visit `/labnotes` (public blog index), `/quote`, `/login` — same check.

- [ ] **Step 8: Commit (deferred to 1.4).**

---

### Task 1.3 — H12 + L1 + L2: Skin labels + CSS comment cleanup + accent triple drift

**Files:**
- Modify: `client/src/components/adminos/Sidebar.js`
- Modify: `client/src/index.css` (comments + accent default values)

#### 1.3a — Sidebar UI labels

- [ ] **Step 1: Open `client/src/components/adminos/Sidebar.js`.** Find the mode-toggle block at lines 77-92.

- [ ] **Step 2: Rename label "Sterile" → "House Lights".** Line 84 contains `>Sterile<`. Replace with `>House Lights<`.

- [ ] **Step 3: Rename label "Experimental" → "After Hours".** Line 91 contains `>Experimental<`. Replace with `>After Hours<`.

#### 1.3b — CSS comment cleanup (Darkroom / Atelier / MAISON)

- [ ] **Step 4: Open `client/src/index.css`.** Find every comment line containing the strings "Darkroom", "Atelier", or "MAISON". Use the editor's find feature.

- [ ] **Step 5: Replace "Darkroom" with "After Hours" in comments.** Expected occurrences (approximate):
  - Around line 6727: `Dr. Bartender Admin OS — Darkroom` → `Dr. Bartender Admin OS — After Hours`
  - Around line 6772: `Skins — dark (darkroom) + light (paper lab)` → `Skins — dark (After Hours) + light (House Lights)`

  Search for `Darkroom` and `darkroom` (case-insensitive). Replace each match — do NOT use replace-all without inspecting each match (some may be in code, not comments).

- [ ] **Step 6: Replace "Atelier" with "House Lights" in comments.** Similar process — search for `Atelier`, replace each comment occurrence with `House Lights`. Approximate locations:
  - Around line 6817: `Atelier — warm paper + deep green, serif display, sans body.` → `House Lights — warm paper + deep green, serif display, sans body.`
  - Several follow-up comments on subsequent rule blocks.

- [ ] **Step 7: Replace "MAISON" with "House Lights" in comments.** The orphan header at line 6807:

```css
/* ============================================================================
   LIGHT SKIN: "MAISON"
```

Becomes:

```css
/* ============================================================================
   LIGHT SKIN: "House Lights"
```

- [ ] **Step 8: Verify no "Darkroom" / "Atelier" / "MAISON" remain in comments.** Run:

```bash
grep -n 'Darkroom\|Atelier\|MAISON' client/src/index.css
```

Inspect every match. Internal CSS variable names like `--ms-emerald` are intentional internal vocabulary (keep — they're not user-facing). Comment-level mentions should all be replaced.

#### 1.3c — Accent triple drift fix

- [ ] **Step 9: Update CSS default accent values.** In `client/src/index.css`, find lines 6731-6735:

```css
html[data-app="admin-os"] {
  /* ── Accent (tweakable) ── */
  --accent-h: 218;
  --accent-s: 35%;
  --accent-l: 40%;
```

Replace with:

```css
html[data-app="admin-os"] {
  /* ── Accent (tweakable; UserPrefsContext also writes these inline at runtime) ── */
  --accent-h: 212;
  --accent-s: 78%;
  --accent-l: 44%;
```

This matches `UserPrefsContext.js:8` `dark.accent = { h: 212, s: 78, l: 44 }` — runtime JS is the source of truth; CSS now mirrors it.

- [ ] **Step 10: Manual verify (sidebar labels).** Reload `http://localhost:3000/admin/dashboard`. Sidebar footer toggle now reads "House Lights" / "After Hours". Click each — both still toggle the skin.

- [ ] **Step 11: Manual verify (no visual regression from accent change).** Toggle to dark skin. Inspect any element using the accent (e.g., active sidebar item). It should look the same as before — the JS was already setting these values at runtime; only the CSS comment-level fallback changed.

---

### Task 1.4 — Commit Batch 1

- [ ] **Step 1: Confirm pending diff.** Run:

```bash
git status
```

Expected modified files:
- `client/src/components/adminos/format.js`
- `client/src/components/adminos/Sidebar.js`
- `client/src/components/adminos/drawers/ClientDrawer.js`
- `client/src/components/adminos/drawers/EventDrawer.js`
- `client/src/components/adminos/drawers/ProposalDrawer.js`
- `client/src/context/UserPrefsContext.js`
- `client/src/index.css`
- `client/src/pages/admin/ClientDetail.js`
- `client/src/pages/admin/EventDetailPage.js`
- `client/src/pages/admin/FinancialsDashboard.js`
- `client/src/pages/admin/ProposalCreate.js`
- `client/src/pages/admin/ProposalDetailPaymentPanel.js`

Plus pre-existing changes in `LocationInput.js` if those weren't stashed — leave them alone.

- [ ] **Step 2: Stage explicitly.** Run:

```bash
git add client/src/components/adminos/format.js client/src/components/adminos/Sidebar.js client/src/components/adminos/drawers/ClientDrawer.js client/src/components/adminos/drawers/EventDrawer.js client/src/components/adminos/drawers/ProposalDrawer.js client/src/context/UserPrefsContext.js client/src/index.css client/src/pages/admin/ClientDetail.js client/src/pages/admin/EventDetailPage.js client/src/pages/admin/FinancialsDashboard.js client/src/pages/admin/ProposalCreate.js client/src/pages/admin/ProposalDetailPaymentPanel.js
```

- [ ] **Step 3: Commit.** Run:

```bash
git commit -m "chore(admin-os): foundation — fmt\$2dp rename, font leak fix, skin label cleanup"
```

- [ ] **Step 4: Confirm commit landed.** Run: `git log --oneline -1`. Expected: a single new commit with the message above.

- [ ] **Step 5: Stand down.** Do NOT push. Push cue is user-initiated only.

---

## Batch 2 — Quick wins (C6, H9, H4, H5, H2)

Five small targeted fixes. Each is a single file (or one delete). Bundle into one commit because they're coupled in intent (post-redesign cleanup polish) and any single one could be reverted without affecting the others.

### Task 2.1 — C6: Remove FinancialsDashboard "Export CSV" button

**File:** `client/src/pages/admin/FinancialsDashboard.js`

- [ ] **Step 1: Open the file.** Locate line 51:

```jsx
<button type="button" className="btn btn-secondary"><Icon name="external" />Export CSV</button>
```

- [ ] **Step 2: Delete the button.** Remove the entire JSX line. If it's wrapped in a flex container with another button, keep the container.

- [ ] **Step 3: Manual verify.** Visit `http://localhost:3000/admin/financials`. Confirm "Export CSV" is gone. Confirm any sibling buttons (Date range, etc.) still render correctly.

---

### Task 2.2 — H9: Delete orphan `ClickableRow.js`

**Files:**
- Delete: `client/src/components/ClickableRow.js`
- Modify: `.claude/CLAUDE.md` (folder tree), `README.md` (folder tree)

- [ ] **Step 1: Verify zero importers.** Run:

```bash
grep -rn 'ClickableRow' client/src/
```

Expected: no matches outside of `client/src/components/ClickableRow.js` itself. If any importer is found, STOP and surface it — the audit's claim was wrong, do not delete.

- [ ] **Step 2: Delete the file.** Run:

```bash
rm client/src/components/ClickableRow.js
```

- [ ] **Step 3: Update CLAUDE.md folder tree.** Open `.claude/CLAUDE.md`. Find the line:

```
│   │   │   ├── ClickableRow.js    # <tr> wrapper: click navigates, drag selects text
```

Delete that line.

- [ ] **Step 4: Update README.md folder tree.** Same process — find the `ClickableRow.js` line in the folder structure section and delete it.

- [ ] **Step 5: Build check.** Run: `cd client && npm run build`. Expected: build succeeds.

---

### Task 2.3 — H4: InvoiceDropdown undefined token fix

**File:** `client/src/components/InvoiceDropdown.js`

- [ ] **Step 1: Open the file.** Find line 62 (status colors). Look for `var(--sage)` or `var(--sage,...)`.

- [ ] **Step 2: Replace `var(--sage)`.** Substitute with:

```js
'hsl(var(--ok-h) var(--ok-s) 52%)'
```

- [ ] **Step 3: Find and replace `var(--rust)`.** Around line 73. Substitute with:

```js
'hsl(var(--danger-h) var(--danger-s) 65%)'
```

- [ ] **Step 4: Verify no `--sage` / `--rust` references remain in this file.** Run:

```bash
grep -n '\-\-sage\|\-\-rust' client/src/components/InvoiceDropdown.js
```

Expected: empty.

- [ ] **Step 5: Manual verify.** Open a proposal with an invoice (`/admin/proposals/<id>`). Open the InvoiceDropdown. Confirm status colors render in both skins (toggle skin to verify both look correct).

---

### Task 2.4 — H5: PricingBreakdown inline chalkboard hex → admin-os tokens

**File:** `client/src/components/PricingBreakdown.js`

- [ ] **Step 1: Read the file.** Identify every `style={{...}}` containing a hex color literal. Per the audit, lines 18, 19, 27, 35, 40, 49 have hardcoded chalkboard hex values.

- [ ] **Step 2: For each hex value, map to an admin-os token.** Quick reference:
  - Cream/parchment background (e.g., `#fcfaf4`, `#f7f4ec`) → `var(--bg-1)`
  - Warm dark text (e.g., `#3d3a33`, `#1a1a1a`) → `var(--ink-1)`
  - Muted brown (e.g., `#7a7468`) → `var(--ink-3)`
  - Hairline (e.g., `#ece6d4`, `#e1dbcc`) → `var(--line-1)`
  - Accent (e.g., chalkboard amber/emerald) → `var(--accent)` or `'hsl(var(--accent-h) var(--accent-s) var(--accent-l))'`

  Read each line in context to pick the right token (a "background" hex maps differently from a "border" hex).

- [ ] **Step 3: Verify no hex literals remain.** Run:

```bash
grep -n '#[0-9a-fA-F]\{3,8\}' client/src/components/PricingBreakdown.js
```

Expected: empty (or only whitelist intentionally non-themed values).

- [ ] **Step 4: Manual verify.** Visit `/admin/proposals/<id>` showing PricingBreakdown. Toggle skin. Confirm colors swap correctly in both states.

---

### Task 2.5 — H2: ProposalDetailPaymentPanel `--ms-*` fallback bugs

**File:** `client/src/pages/admin/ProposalDetailPaymentPanel.js`

- [ ] **Step 1: Find `--ms-*` references.** Lines 167, 243, 262 per the audit. Use:

```bash
grep -n '\-\-ms\-' client/src/pages/admin/ProposalDetailPaymentPanel.js
```

- [ ] **Step 2: Replace each `var(--ms-camel, ...)` instance** with skin-responsive HSL:

```js
'hsl(var(--warn-h) var(--warn-s) 58%)'
```

- [ ] **Step 3: Replace each `var(--ms-emerald, ...)` instance** with:

```js
'hsl(var(--ok-h) var(--ok-s) 38%)'
```

If the visual result reads too dark in After Hours, raise lightness to `52%` and re-verify.

- [ ] **Step 4: Replace each `var(--ms-bordeaux, ...)` instance** with:

```js
'hsl(var(--danger-h) var(--danger-s) 50%)'
```

- [ ] **Step 5: Verify no `--ms-*` references remain in this file.** Run:

```bash
grep -n '\-\-ms\-' client/src/pages/admin/ProposalDetailPaymentPanel.js
```

Expected: empty.

- [ ] **Step 6: Manual verify.** Visit a proposal with payment activity. Toggle to After Hours skin. Confirm the warn / ok / danger colors on the payment panel render correctly (not as light-skin colors against a dark background).

---

### Task 2.6 — Commit Batch 2

- [ ] **Step 1: Stage explicitly.**

```bash
git add client/src/pages/admin/FinancialsDashboard.js .claude/CLAUDE.md README.md client/src/components/InvoiceDropdown.js client/src/components/PricingBreakdown.js client/src/pages/admin/ProposalDetailPaymentPanel.js
```

(Note: `ClickableRow.js` deletion is captured automatically by the modification of the folder-tree docs and the file removal — `git add -u` would catch the delete but we're staging explicitly per project rules. Use `git add` on the deleted path explicitly:)

```bash
git add client/src/components/ClickableRow.js
```

(`git add` on a removed-from-disk path stages the deletion.)

- [ ] **Step 2: Commit.**

```bash
git commit -m "chore(admin-os): quick wins — drop Export CSV + ClickableRow, fix undefined CSS tokens"
```

- [ ] **Step 3: Confirm commit.** Run: `git log --oneline -1`.

- [ ] **Step 4: Stand down.** Do NOT push.

---

## Batch 3 — Auth + staff cleanup (H6, H11)

### Task 3.1 — H6: Login `/apply` redirect cross-domain

**File:** `client/src/pages/Login.js`

- [ ] **Step 1: Open the file.** Find lines 39-42 (the in_progress redirect).

- [ ] **Step 2: Locate the existing redirect logic.** It should resemble:

```js
if (user.role === 'staff' && (user.application_status === 'in_progress' || !user.has_application)) {
  navigate('/apply');
  return;
}
```

(Exact wording may differ — read the actual code before editing.)

- [ ] **Step 3: Branch on hostname.** Replace the navigate call with:

```js
if (user.role === 'staff' && (user.application_status === 'in_progress' || !user.has_application)) {
  if (window.location.hostname.startsWith('staff.')) {
    const params = new URLSearchParams();
    if (user.email) params.set('email', user.email);
    const qs = params.toString();
    window.location.assign('https://hiring.drbartender.com/apply' + (qs ? '?' + qs : ''));
    return;
  }
  navigate('/apply');
  return;
}
```

- [ ] **Step 4: Manual verify (positive).** Sign in on `http://localhost:3000` as a user with `application_status === 'in_progress'`. Confirm the existing redirect to `/apply` still works on localhost (hostname is `localhost`, not starting with `staff.`).

- [ ] **Step 5: Manual verify (cross-domain).** Optionally simulate `staff.drbartender.com` locally by editing the system hosts file to point `staff.local` to `127.0.0.1`, then visit `http://staff.local:3000/login` and sign in with an in_progress user. Confirm the page redirects to `https://hiring.drbartender.com/apply?email=...`. (If hosts editing isn't possible, defer this to staging verification — but the code path is small enough to be confident.)

---

### Task 3.2 — H11: Staff portal `useToast` on swallowed errors

**Files:**
- Modify: `client/src/pages/staff/StaffShifts.js`
- Modify: `client/src/pages/staff/StaffSchedule.js`
- Modify: `client/src/pages/staff/StaffEvents.js`
- Modify: `client/src/pages/staff/StaffDashboard.js`
- Modify: `client/src/pages/staff/StaffProfile.js`

For each file, follow this pattern:

- [ ] **Step 1: Add `useToast` import.** At the top:

```js
import { useToast } from '../../context/ToastContext';
```

- [ ] **Step 2: Get toast in the component.** Inside the component function:

```js
const toast = useToast();
```

- [ ] **Step 3: Replace each `.catch(console.error)` (read-fail).** For fetches that load data:

Before:
```js
.catch(console.error);
// or
.catch(err => console.error(err));
```

After:
```js
.catch(err => {
  console.error(err);
  toast.error("Couldn't load <thing>. Try refreshing.");
});
```

Where `<thing>` is the resource (shifts, schedule, events, profile, dashboard).

- [ ] **Step 4: Replace each write-mutation `.catch(...)` (write-fail).** For Approve / Decline / Submit / Update actions:

Before:
```js
.catch(console.error);
```

After:
```js
.catch(err => {
  console.error(err);
  toast.error(err.response?.data?.error || err.message || 'Something went wrong.');
});
```

- [ ] **Step 5: Repeat for each of the 5 staff files** following the same pattern.

- [ ] **Step 6: Manual verify.** With dev server running, sign in as a staff user. Disconnect WiFi briefly (or stop the backend with Ctrl+C in the dev terminal where Express runs). Visit `/portal/shifts`. Confirm a toast appears: "Couldn't load shifts. Try refreshing." Restart the backend.

- [ ] **Step 7: Optional verify (write-fail).** With backend running, attempt a Decline on a shift you don't have permission to decline (or temporarily make the API return an error). Confirm the toast displays the actual API error message, not a generic one.

---

### Task 3.3 — Commit Batch 3

- [ ] **Step 1: Stage.**

```bash
git add client/src/pages/Login.js client/src/pages/staff/StaffShifts.js client/src/pages/staff/StaffSchedule.js client/src/pages/staff/StaffEvents.js client/src/pages/staff/StaffDashboard.js client/src/pages/staff/StaffProfile.js
```

- [ ] **Step 2: Commit.**

```bash
git commit -m "fix(auth/staff): cross-domain /apply redirect on staff.* and toasts on staff portal API errors"
```

- [ ] **Step 3: Stand down.**

---

## Batch 4 — Density toggle (C7)

Single feature, multi-file change. Touches UserPrefsContext (default + migration), Sidebar.js (new toggle row + footer rewrite), and index.css (footer layout + active-state visibility). One commit.

### Task 4.1 — UserPrefsContext: default + migration

**File:** `client/src/context/UserPrefsContext.js`

- [ ] **Step 1: Update DEFAULT_PREFS.** Find line 4:

```js
const DEFAULT_PREFS = { skin: 'dark', density: 'normal', sidebar: 'full' };
```

Replace with:

```js
const DEFAULT_PREFS = { skin: 'dark', density: 'comfy', sidebar: 'full' };
```

- [ ] **Step 2: Add migration in `load()` function.** Find the `load(user)` function (around lines 43-54). Replace its body with:

```js
function load(user) {
  const key = storageKey(user);
  if (!key) return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw);
    // Migrate legacy 'normal' density values to the new 2-state system.
    if (parsed.density === 'normal') parsed.density = 'comfy';
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return DEFAULT_PREFS;
  }
}
```

- [ ] **Step 3: Build check.** Run: `cd client && npm run build`. Expected: success.

---

### Task 4.2 — Sidebar.js: new density toggle + footer layout

**File:** `client/src/components/adminos/Sidebar.js`

- [ ] **Step 1: Locate the existing footer block.** Around lines 67-93, find:

```jsx
<div className="sidebar-footer">
  <button ... onClick={() => setPref('sidebar', ...)}>...</button>
  <div className="mode-toggle" role="radiogroup" aria-label="Visual mode">
    <button ... onClick={() => prefs.skin !== 'light' && setPref('skin', 'light')}>House Lights</button>
    <button ... onClick={() => prefs.skin !== 'dark' && setPref('skin', 'dark')}>After Hours</button>
  </div>
</div>
```

- [ ] **Step 2: Replace the footer block** with the new structure (collapse row + skin row + density row, all inside one `.sidebar-footer-controls` group, then a separate user row):

```jsx
<div className="sidebar-footer sidebar-footer-controls">
  <button
    type="button"
    className="sidebar-footer-action"
    title={prefs.sidebar === 'rail' ? 'Expand sidebar' : 'Collapse to rail'}
    onClick={() => setPref('sidebar', prefs.sidebar === 'rail' ? 'full' : 'rail')}
  >
    <Icon name={prefs.sidebar === 'rail' ? 'right' : 'left'} size={13} />
  </button>
  <div className="mode-toggle" role="radiogroup" aria-label="Visual mode">
    <button
      type="button"
      role="radio"
      aria-checked={prefs.skin === 'light'}
      className={`mode-opt ${prefs.skin === 'light' ? 'active' : ''}`}
      onClick={() => prefs.skin !== 'light' && setPref('skin', 'light')}
    >House Lights</button>
    <button
      type="button"
      role="radio"
      aria-checked={prefs.skin === 'dark'}
      className={`mode-opt ${prefs.skin === 'dark' ? 'active' : ''}`}
      onClick={() => prefs.skin !== 'dark' && setPref('skin', 'dark')}
    >After Hours</button>
  </div>
  <div className="mode-toggle" role="radiogroup" aria-label="Density">
    <button
      type="button"
      role="radio"
      aria-checked={prefs.density === 'comfy'}
      className={`mode-opt ${prefs.density === 'comfy' ? 'active' : ''}`}
      onClick={() => prefs.density !== 'comfy' && setPref('density', 'comfy')}
    >Comfy</button>
    <button
      type="button"
      role="radio"
      aria-checked={prefs.density === 'compact'}
      className={`mode-opt ${prefs.density === 'compact' ? 'active' : ''}`}
      onClick={() => prefs.density !== 'compact' && setPref('density', 'compact')}
    >Compact</button>
  </div>
</div>

<div className="sidebar-footer sidebar-footer--user">
  <div className="avatar">{initialsOf(user)}</div>
  <div className="sidebar-footer-main">
    <div className="sidebar-footer-name">{user?.name || user?.email || 'Signed in'}</div>
    <div className="sidebar-footer-role">{roleLabel(user?.role)} · Dr. Bartender</div>
  </div>
  <button type="button" className="sidebar-footer-action" title="Sign out" onClick={handleLogout}>
    <Icon name="logout" size={13} />
  </button>
</div>
```

- [ ] **Step 3: Remove inline `style={{ width: '100%', ... }}` from the collapse button.** It's redundant with the new CSS class layout. (See line ~73 in the original.)

---

### Task 4.3 — index.css: footer layout + skin/density active-state

**File:** `client/src/index.css`

- [ ] **Step 1: Find existing `.sidebar-footer` and `.mode-toggle` rules.** Use:

```bash
grep -n '\.sidebar-footer\|\.mode-toggle' client/src/index.css
```

- [ ] **Step 2: Add (or update) sidebar-footer-controls layout.** Inside the admin-os scope (find the appropriate location — search for the existing sidebar styles around line 7700 onward). Add this rule block:

```css
html[data-app="admin-os"] .sidebar-footer-controls {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 8px;
  border-top: 1px solid var(--line-1);
}

html[data-app="admin-os"] .sidebar-footer-controls .sidebar-footer-action {
  width: 100%;
  display: flex;
  justify-content: center;
  padding: 6px 0;
}

html[data-app="admin-os"] .mode-toggle {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
  border: 1px solid var(--line-2);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

html[data-app="admin-os"] .mode-opt {
  background: var(--bg-2);
  color: var(--ink-3);
  border: none;
  padding: 6px 8px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}

html[data-app="admin-os"] .mode-opt:hover {
  background: var(--row-hover);
  color: var(--ink-1);
}

html[data-app="admin-os"] .mode-opt.active {
  background: var(--accent);
  color: hsl(var(--accent-h) calc(var(--accent-s) * 0.4) 95%);
}

/* Skin-specific override: in House Lights, the active state uses ms-emerald for clearer hierarchy */
html[data-app="admin-os"][data-skin="light"] .mode-opt.active {
  background: var(--ms-emerald);
  color: var(--bg-1);
}
```

- [ ] **Step 3: Audit any duplicate or conflicting `.mode-toggle` rules.** Search the file for other `.mode-toggle` definitions and remove any that conflict with the new ones above. The previous design likely had narrower rules — replace, don't double-define.

- [ ] **Step 4: Manual verify (visual layout).** Reload `/admin/dashboard`. Sidebar footer should show:
  - Collapse button (one row)
  - Skin radio (House Lights | After Hours)
  - Density radio (Comfy | Compact)
  - User row (avatar + name + sign-out)

  All four sections visually distinct, breathing room between them, no "mushed" appearance.

- [ ] **Step 5: Manual verify (active-state visibility on click).** Click the inactive skin segment. The clicked segment must immediately turn into the accent color (visible at the click target — this is the user's first-perceived feedback). Same test for the density toggle.

- [ ] **Step 6: Manual verify (skin and density both apply).** Toggle to After Hours. Page background swaps to dark. Toggle to House Lights. Page background swaps to paper. Toggle Compact. Row heights shrink across the page. Toggle Comfy. Row heights grow back.

- [ ] **Step 7: Manual verify (migration).** In DevTools console, run:

```js
const userId = JSON.parse(localStorage.getItem('drb-admin-prefs-1') || '{}');
console.log(userId);
```

(Or inspect localStorage directly under your user ID.) The stored object should have `density: 'comfy'` (not `'normal'`). If you had a pre-existing `'normal'` value, it should have been migrated on next load.

---

### Task 4.4 — Commit Batch 4

- [ ] **Step 1: Stage.**

```bash
git add client/src/context/UserPrefsContext.js client/src/components/adminos/Sidebar.js client/src/index.css
```

- [ ] **Step 2: Commit.**

```bash
git commit -m "feat(admin-os): density toggle in sidebar footer (Comfy/Compact) + footer layout fix"
```

- [ ] **Step 3: Stand down.**

---

## Batch 5 — Cross-cutting component dark-skin overrides (H3)

Add `[data-app="admin-os"]` scoped overrides for 9 components. Each component is a small, independent CSS-only change. Bundle into one commit because they share the same intent ("matchy-matchy") and any one could be reverted without affecting the others.

For each component, the pattern is identical: read the existing CSS rule(s) for the component in `index.css`, identify the colors/borders/shadows that need to swap with skin, write a parallel `[data-app="admin-os"]` block.

### Task 5.1 — Toast

**File:** `client/src/index.css`

- [ ] **Step 1: Find existing Toast CSS.** Search for `.toast` selectors:

```bash
grep -n '\.toast\b\|\.toast-' client/src/index.css
```

- [ ] **Step 2: Read each existing rule** to inventory the chalkboard colors used (likely cream backgrounds, brown text, soft borders).

- [ ] **Step 3: Add admin-os scoped overrides** at the end of the existing Toast block:

```css
/* Admin OS — Toast scoped to admin shell (auto-swaps with skin) */
html[data-app="admin-os"] .toast {
  background: var(--bg-1);
  color: var(--ink-1);
  border: 1px solid var(--line-2);
  box-shadow: var(--shadow-pop);
}

html[data-app="admin-os"] .toast-success {
  border-left: 3px solid hsl(var(--ok-h) var(--ok-s) 45%);
}

html[data-app="admin-os"] .toast-error {
  border-left: 3px solid hsl(var(--danger-h) var(--danger-s) 50%);
}

html[data-app="admin-os"] .toast-info {
  border-left: 3px solid hsl(var(--info-h) var(--info-s) 45%);
}

html[data-app="admin-os"] .toast .toast-close {
  color: var(--ink-3);
}
html[data-app="admin-os"] .toast .toast-close:hover {
  color: var(--ink-1);
}
```

(Adjust selector specifics to match the actual Toast component's class names — read `client/src/components/Toast.js` to confirm.)

---

### Task 5.2 — ConfirmModal

- [ ] **Step 1: Find existing ConfirmModal CSS.**

```bash
grep -n '\.confirm-modal\|\.confirm-dialog' client/src/index.css
```

- [ ] **Step 2: Add admin-os overrides** after the existing block:

```css
html[data-app="admin-os"] .confirm-modal,
html[data-app="admin-os"] .confirm-dialog {
  background: var(--bg-elev);
  color: var(--ink-1);
  border: 1px solid var(--line-2);
  box-shadow: var(--shadow-pop);
  border-radius: var(--radius);
}

html[data-app="admin-os"] .confirm-modal .confirm-title {
  color: var(--ink-1);
  font-family: var(--font-display);
}

html[data-app="admin-os"] .confirm-modal .confirm-body {
  color: var(--ink-2);
}

html[data-app="admin-os"] .confirm-modal .confirm-actions .btn-cancel {
  background: var(--bg-3);
  color: var(--ink-2);
  border: 1px solid var(--line-1);
}

html[data-app="admin-os"] .confirm-modal .confirm-actions .btn-confirm {
  background: var(--accent);
  color: hsl(var(--accent-h) calc(var(--accent-s) * 0.4) 95%);
  border: none;
}

html[data-app="admin-os"] .confirm-modal .confirm-actions .btn-confirm.danger {
  background: hsl(var(--danger-h) var(--danger-s) 50%);
}

html[data-app="admin-os"] .confirm-modal-overlay,
html[data-app="admin-os"] .confirm-backdrop {
  background: rgba(0, 0, 0, 0.6);
}
```

(Adjust class names per actual ConfirmModal.js — check before applying.)

---

### Task 5.3 — FormBanner

- [ ] **Step 1: Find existing FormBanner CSS.**

```bash
grep -n '\.form-banner\|\.form-banner-' client/src/index.css
```

- [ ] **Step 2: Add admin-os overrides:**

```css
html[data-app="admin-os"] .form-banner-error {
  background: hsl(var(--danger-h) var(--danger-s) 18%);
  color: hsl(var(--danger-h) var(--danger-s) 85%);
  border: 1px solid hsl(var(--danger-h) var(--danger-s) 35%);
  border-radius: var(--radius-sm);
}

html[data-app="admin-os"][data-skin="light"] .form-banner-error {
  background: hsl(var(--danger-h) var(--danger-s) 95%);
  color: hsl(var(--danger-h) var(--danger-s) 30%);
  border-color: hsl(var(--danger-h) var(--danger-s) 60%);
}
```

---

### Task 5.4 — FieldError

- [ ] **Step 1: Find existing FieldError CSS.**

```bash
grep -n '\.field-error' client/src/index.css
```

- [ ] **Step 2: Add admin-os overrides:**

```css
html[data-app="admin-os"] .field-error {
  color: hsl(var(--danger-h) var(--danger-s) 65%);
  font-size: 11px;
}

html[data-app="admin-os"][data-skin="light"] .field-error {
  color: hsl(var(--danger-h) var(--danger-s) 35%);
}
```

---

### Task 5.5 — FileUpload

- [ ] **Step 1: Find existing FileUpload CSS.**

```bash
grep -n '\.file-upload' client/src/index.css
```

- [ ] **Step 2: Add admin-os overrides:**

```css
html[data-app="admin-os"] .file-upload-area {
  background: var(--bg-2);
  color: var(--ink-3);
  border: 2px dashed var(--line-2);
  border-radius: var(--radius);
}

html[data-app="admin-os"] .file-upload-area.drag-over,
html[data-app="admin-os"] .file-upload-area:hover {
  background: var(--row-hover);
  color: var(--ink-1);
  border-color: var(--accent);
}

html[data-app="admin-os"] .file-upload-error {
  color: hsl(var(--danger-h) var(--danger-s) 65%);
}

html[data-app="admin-os"] .file-upload-list .file-item {
  background: var(--bg-3);
  color: var(--ink-1);
  border: 1px solid var(--line-1);
}
```

---

### Task 5.6 — TimePicker

- [ ] **Step 1: Find existing TimePicker CSS.** It's already partially scoped (some rules use `html[data-app="admin-os"]` per the audit). Search:

```bash
grep -n '\.time-picker' client/src/index.css
```

- [ ] **Step 2: Add admin-os overrides for popover/dropdown** (the existing scoped rules cover the input; the dropdown likely uses unscoped rules):

```css
html[data-app="admin-os"] .time-picker-dropdown {
  background: var(--bg-elev);
  color: var(--ink-1);
  border: 1px solid var(--line-2);
  box-shadow: var(--shadow-pop);
}

html[data-app="admin-os"] .time-picker-dropdown li {
  color: var(--ink-2);
}

html[data-app="admin-os"] .time-picker-dropdown li:hover {
  background: var(--row-hover);
  color: var(--ink-1);
}

html[data-app="admin-os"] .time-picker-dropdown li.selected {
  background: var(--accent-soft);
  color: var(--accent);
}

html[data-app="admin-os"] .time-picker-chevron {
  color: var(--ink-3);
}

html[data-app="admin-os"] .time-picker-stepper {
  color: var(--ink-3);
}
html[data-app="admin-os"] .time-picker-stepper:hover {
  color: var(--accent);
}
```

---

### Task 5.7 — NumberStepper

- [ ] **Step 1: Find existing NumberStepper CSS.**

```bash
grep -n '\.number-stepper' client/src/index.css
```

- [ ] **Step 2: Add admin-os overrides** for stepper buttons (the input is already scoped per audit):

```css
html[data-app="admin-os"] .number-stepper-steppers {
  background: transparent;
}

html[data-app="admin-os"] .number-stepper-stepper {
  color: var(--ink-3);
}

html[data-app="admin-os"] .number-stepper-stepper:hover {
  color: var(--accent);
}

html[data-app="admin-os"] .number-stepper-stepper:disabled {
  color: var(--ink-4);
  cursor: not-allowed;
}
```

---

### Task 5.8 — LocationInput

- [ ] **Step 1: Find existing LocationInput CSS / inline styles.** The audit noted inline styles in the component itself. Read `client/src/components/LocationInput.js` first.

- [ ] **Step 2: For each inline style hex,** convert to CSS class + admin-os scoped override. If the audit pre-modified file is still in the working tree, coordinate with those changes carefully.

```css
html[data-app="admin-os"] .location-suggest {
  background: var(--bg-elev);
  color: var(--ink-1);
  border: 1px solid var(--line-2);
  box-shadow: var(--shadow-pop);
}

html[data-app="admin-os"] .location-suggest-item {
  color: var(--ink-2);
}

html[data-app="admin-os"] .location-suggest-item:hover,
html[data-app="admin-os"] .location-suggest-item.active {
  background: var(--row-hover);
  color: var(--ink-1);
}
```

(If the inline styles need refactoring to classes first, do that as part of this task — replace `style={{...}}` literals with `className="..."` in the component.)

---

### Task 5.9 — InvoiceDropdown (dark-skin override beyond H4)

H4 already converted the undefined tokens. This task adds the structural dark-skin override.

- [ ] **Step 1: Find existing InvoiceDropdown CSS / inline styles.**

```bash
grep -n '\.invoice-dropdown' client/src/index.css
```

- [ ] **Step 2: Add admin-os overrides:**

```css
html[data-app="admin-os"] .invoice-dropdown {
  background: var(--bg-elev);
  color: var(--ink-1);
  border: 1px solid var(--line-2);
  box-shadow: var(--shadow-pop);
}

html[data-app="admin-os"] .invoice-dropdown-item {
  color: var(--ink-2);
  border-bottom: 1px solid var(--line-1);
}

html[data-app="admin-os"] .invoice-dropdown-item:hover {
  background: var(--row-hover);
  color: var(--ink-1);
}
```

---

### Task 5.10 — Manual verify (cross-skin, multiple admin pages)

- [ ] **Step 1: Toggle to After Hours.** Visit each of these in turn and confirm the corresponding component looks correct (dark surfaces, light text, no orphan-color elements):

| Component | Where to test |
|---|---|
| Toast | Trigger any save action (e.g., update proposal notes) |
| ConfirmModal | Click Delete on any deletable entity (e.g., a draft proposal) |
| FormBanner | Submit a form with invalid input on `/admin/proposals/new` |
| FieldError | Same — error text under the offending input |
| FileUpload | Visit a page with a file upload (e.g., admin user W9 page if any, or BlogDashboard image upload) |
| TimePicker | `/admin/proposals/new` start time field |
| NumberStepper | `/admin/proposals/new` num_bartenders field |
| LocationInput | `/admin/proposals/new` event location field |
| InvoiceDropdown | A proposal with at least one invoice |

- [ ] **Step 2: Toggle to House Lights.** Repeat. All components must render correctly in light skin too.

- [ ] **Step 3: Verify no public-side regression.** Visit `/quote` (uses TimePicker, possibly LocationInput). Public site should look unchanged from before this batch.

---

### Task 5.11 — Commit Batch 5

- [ ] **Step 1: Stage.**

```bash
git add client/src/index.css client/src/components/LocationInput.js
```

(Add LocationInput.js if you refactored inline styles to classes in 5.8.)

- [ ] **Step 2: Commit.**

```bash
git commit -m "feat(admin-os): cross-cutting component dark-skin overrides for 9 shared widgets"
```

- [ ] **Step 3: Stand down.**

---

## Batch 6 — Shift drawer + ShiftDetail retirement (C5)

Bigger surgery. Build a new `ShiftDrawer`, wire it from EventDetailPage shift rows, retire ShiftDetail, redirect old URLs. One commit (drawer build + wiring + retirement are interdependent).

### Task 6.1 — Read existing ShiftDetail.js to inventory what to migrate

**File (read-only):** `client/src/pages/admin/ShiftDetail.js`

- [ ] **Step 1: Open the file.** Read every state hook, every API call, every action handler. Make notes (in your own working memory or a scratch file):
  - All `api.get/post/patch/put/delete` paths used
  - All buttons and their handlers (approve, decline, SMS, remove, manual-add)
  - The list of pending requests + currently assigned staff structure
  - Anything else (notes, equipment, setup time)

- [ ] **Step 2: Verify the API endpoints exist server-side.** Quick spot-check in `server/routes/shifts.js`:

```bash
grep -n 'router\.\(get\|post\|patch\|put\|delete\)' server/routes/shifts.js
```

Expected: matches for `/shifts/:id/assign`, `/shifts/:id/requests/:requestId/approve` (or similar), etc. The drawer reuses these — no new server routes needed.

---

### Task 6.2 — Create `ShiftDrawer.js`

**File:** `client/src/components/adminos/drawers/ShiftDrawer.js` (new)

- [ ] **Step 1: Read sibling drawers for the pattern.** Open `client/src/components/adminos/drawers/EventDrawer.js`. Note:
  - How it's invoked (props, hooks)
  - How it uses the `<Drawer>` primitive from `client/src/components/adminos/Drawer.js`
  - How it loads data (useEffect + api call)
  - How it handles errors

- [ ] **Step 2: Create the new file.** Skeleton:

```jsx
import React, { useEffect, useState, useCallback } from 'react';
import api from '../../../utils/api';
import Drawer from '../Drawer';
import Icon from '../Icon';
import StatusChip from '../StatusChip';
import { fmtDate } from '../format';
import { useToast } from '../../../context/ToastContext';

export default function ShiftDrawer({ shiftId, onClose }) {
  const toast = useToast();
  const [shift, setShift] = useState(null);
  const [requests, setRequests] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeStaff, setActiveStaff] = useState([]);

  const loadAll = useCallback(() => {
    if (!shiftId) return;
    setLoading(true);
    Promise.all([
      api.get(`/shifts/${shiftId}`),
      api.get(`/shifts/${shiftId}/requests`),
      api.get(`/shifts/${shiftId}/assignments`),
    ])
      .then(([shiftRes, reqRes, asnRes]) => {
        setShift(shiftRes.data);
        setRequests(reqRes.data || []);
        setAssignments(asnRes.data || []);
      })
      .catch(err => {
        console.error(err);
        toast.error("Couldn't load shift. Try again.");
      })
      .finally(() => setLoading(false));
  }, [shiftId, toast]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Lazy-load active staff for manual-add
  useEffect(() => {
    if (!shiftId) return;
    api.get('/admin/active-staff').then(r => setActiveStaff(r.data || [])).catch(() => {});
  }, [shiftId]);

  const handleApprove = (requestId) => {
    api.post(`/shifts/${shiftId}/requests/${requestId}/approve`)
      .then(() => { loadAll(); toast.success('Request approved'); })
      .catch(err => toast.error(err.response?.data?.error || err.message || 'Approve failed'));
  };

  const handleDecline = (requestId) => {
    api.post(`/shifts/${shiftId}/requests/${requestId}/decline`)
      .then(() => { loadAll(); toast.success('Request declined'); })
      .catch(err => toast.error(err.response?.data?.error || err.message || 'Decline failed'));
  };

  const handleRemoveAssignment = (assignmentId) => {
    api.delete(`/shifts/${shiftId}/assignments/${assignmentId}`)
      .then(() => { loadAll(); toast.success('Removed'); })
      .catch(err => toast.error(err.response?.data?.error || err.message || 'Remove failed'));
  };

  const handleSmsAssignment = (assignment) => {
    // Reuse existing message route — see ShiftDetail.js for the exact endpoint
    api.post(`/messages/single`, { user_id: assignment.user_id, body: 'Reminder: your shift is coming up.' })
      .then(() => toast.success('SMS sent'))
      .catch(err => toast.error(err.response?.data?.error || err.message || 'SMS failed'));
  };

  const handleManualAssign = (userId) => {
    api.post(`/shifts/${shiftId}/assign`, { user_id: userId })
      .then(() => { loadAll(); toast.success('Assigned'); })
      .catch(err => toast.error(err.response?.data?.error || err.message || 'Assign failed'));
  };

  if (!shiftId) return null;

  return (
    <Drawer onClose={onClose} title={shift ? `${shift.role} shift` : 'Loading…'}>
      {loading && <div className="drawer-loading">Loading…</div>}
      {!loading && shift && (
        <>
          <section className="drawer-section">
            <h4 className="section-title">Event</h4>
            <div className="dl">
              <div><span className="meta-k">Event</span><span>{shift.event_name || `#${shift.event_id}`}</span></div>
              <div><span className="meta-k">Date</span><span>{fmtDate(shift.event_date)}</span></div>
              <div><span className="meta-k">Time</span><span>{shift.start_time}–{shift.end_time}</span></div>
              <div><span className="meta-k">Positions</span><span>{assignments.length}/{shift.position_count} filled</span></div>
            </div>
          </section>

          <section className="drawer-section">
            <h4 className="section-title">Requests ({requests.length})</h4>
            {requests.length === 0 && <p className="empty">No pending requests.</p>}
            {requests.map(r => (
              <div key={r.id} className="drawer-row">
                <div>
                  <div className="drawer-row-name">{r.user_name}</div>
                  <div className="drawer-row-meta">applied {fmtDate(r.created_at)}</div>
                </div>
                <div className="drawer-row-actions">
                  <button className="btn btn-sm btn-primary" onClick={() => handleApprove(r.id)}>Approve</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => handleDecline(r.id)}>Decline</button>
                </div>
              </div>
            ))}
          </section>

          <section className="drawer-section">
            <h4 className="section-title">Assigned ({assignments.length})</h4>
            {assignments.length === 0 && <p className="empty">No staff assigned yet.</p>}
            {assignments.map(a => (
              <div key={a.id} className="drawer-row">
                <div>
                  <div className="drawer-row-name">{a.user_name}</div>
                  <StatusChip kind={a.confirmed ? 'ok' : 'warn'}>
                    {a.confirmed ? 'Confirmed' : 'Pending response'}
                  </StatusChip>
                </div>
                <div className="drawer-row-actions">
                  <button className="btn btn-sm btn-secondary" onClick={() => handleSmsAssignment(a)}>
                    <Icon name="message" size={12} /> SMS
                  </button>
                  <button className="btn btn-sm btn-secondary" onClick={() => handleRemoveAssignment(a.id)}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </section>

          <section className="drawer-section">
            <h4 className="section-title">Add staff manually</h4>
            <select
              className="input"
              defaultValue=""
              onChange={(e) => e.target.value && handleManualAssign(Number(e.target.value))}
            >
              <option value="">Select staff…</option>
              {activeStaff.map(s => (
                <option key={s.id} value={s.id}>{s.name || s.email}</option>
              ))}
            </select>
          </section>
        </>
      )}
    </Drawer>
  );
}
```

(Customize endpoint paths, field names, and confirmed-state logic to match the actual API and DB returned shape — verify against the existing ShiftDetail.js. The above is a structural template.)

---

### Task 6.3 — Wire `ShiftDrawer` into EventDetailPage shift rows

**File:** `client/src/pages/admin/EventDetailPage.js`

- [ ] **Step 1: Add import.** At the top:

```js
import ShiftDrawer from '../../components/adminos/drawers/ShiftDrawer';
import { useDrawerParam } from '../../hooks/useDrawerParam';
```

- [ ] **Step 2: Wire drawer state.** Inside the component:

```js
const { drawerType, drawerId, openDrawer, closeDrawer } = useDrawerParam();
```

- [ ] **Step 3: Add Manage button to each shift row.** Find the shift rendering loop. Add a `[Manage]` button:

```jsx
<button
  type="button"
  className="btn btn-sm btn-secondary"
  onClick={() => openDrawer('shift', shift.id)}
>
  Manage
</button>
```

- [ ] **Step 4: Render the drawer at the page bottom.**

```jsx
{drawerType === 'shift' && drawerId && (
  <ShiftDrawer
    shiftId={Number(drawerId)}
    onClose={closeDrawer}
  />
)}
```

---

### Task 6.4 — Redirect old `/admin/events/shift/:id` URLs

**File:** `client/src/App.js`

- [ ] **Step 1: Find existing route.** Search for `events/shift/:id` in App.js.

- [ ] **Step 2: Replace with redirect handler.** Define a small redirect component (inline or in a new file):

```jsx
function ShiftDetailRedirect() {
  const { id } = useParams();
  const navigate = useNavigate();
  useEffect(() => {
    api.get(`/shifts/${id}`)
      .then(r => {
        const eventId = r.data.event_id;
        navigate(`/admin/events/${eventId}?drawer=shift&drawerId=${id}`, { replace: true });
      })
      .catch(() => navigate('/admin/events', { replace: true }));
  }, [id, navigate]);
  return <div className="page-loading">Redirecting…</div>;
}
```

Replace the existing route element with `<ShiftDetailRedirect />`.

- [ ] **Step 3: Remove ShiftDetail import and usage.** Delete the `import ShiftDetail from ...` line if no other route uses it.

---

### Task 6.5 — Delete `ShiftDetail.js`

**File:** `client/src/pages/admin/ShiftDetail.js`

- [ ] **Step 1: Verify no imports remain.** Run:

```bash
grep -rn 'ShiftDetail' client/src/
```

Expected: zero references (after Task 6.4 removed the App.js import). If any importer remains, fix that first.

- [ ] **Step 2: Delete the file.** Run:

```bash
rm client/src/pages/admin/ShiftDetail.js
```

- [ ] **Step 3: Update folder-tree docs.** In `.claude/CLAUDE.md` and `README.md`, find and delete the `ShiftDetail.js` entry from the folder structure. In `.claude/CLAUDE.md`, also add a `ShiftDrawer.js` entry under `components/adminos/drawers/`. (No README change needed for the new drawer — README's tree may not list every drawer.)

---

### Task 6.6 — Update CommandPalette if it references shift detail

- [ ] **Step 1: Check.** Run:

```bash
grep -n 'shift' client/src/components/adminos/CommandPalette.js
```

- [ ] **Step 2: If found, remove or redirect to events list.** Most likely this is fine — palette navigates to lists, not shift detail. Verify and update if needed.

---

### Task 6.7 — Manual verify

- [ ] **Step 1: Drawer opens from EventDetailPage.** Visit `/admin/events/<id>` for an event with at least one shift. Click [Manage] on a shift row. Drawer slides in. Header shows shift role + event name + date + positions count.

- [ ] **Step 2: Requests load and approve/decline.** If the shift has pending requests, they appear under "Requests". Click [Approve] on one — toast appears, request disappears, assignment list updates.

- [ ] **Step 3: Assigned section shows current staff.** Each row shows name + confirmation status + SMS / Remove buttons.

- [ ] **Step 4: SMS button fires.** Click [SMS] on an assigned staff member. Toast: "SMS sent." Verify (in admin SMS log if available, or by checking Twilio dashboard) the message went out.

- [ ] **Step 5: Remove button unassigns.** Click [Remove]. Toast appears, row disappears.

- [ ] **Step 6: Manual assign works.** Pick a staff member from the dropdown. Toast: "Assigned." Row appears in Assigned section.

- [ ] **Step 7: Old URL redirects.** Visit `http://localhost:3000/admin/events/shift/<existing-shift-id>` directly (an old bookmark / email link). Page should resolve to `/admin/events/<event-id>?drawer=shift&drawerId=<shift-id>` with the drawer open.

- [ ] **Step 8: Close drawer returns to EventDetailPage.** Click [Close ×] on the drawer. URL drops the `?drawer=` query. Scroll position preserved.

- [ ] **Step 9: Both skins work.** Toggle to After Hours and to House Lights. Drawer renders correctly in each.

---

### Task 6.8 — Commit Batch 6

- [ ] **Step 1: Stage.**

```bash
git add client/src/components/adminos/drawers/ShiftDrawer.js client/src/pages/admin/EventDetailPage.js client/src/App.js client/src/pages/admin/ShiftDetail.js .claude/CLAUDE.md README.md
```

(Plus CommandPalette.js if you modified it in 6.6.)

- [ ] **Step 2: Commit.**

```bash
git commit -m "feat(admin-os): retire ShiftDetail page; new ShiftDrawer with redirect from old URL"
```

- [ ] **Step 3: Stand down.**

---

## Batch 7 — Events kebab menu (H7)

Wire the five actions defined in the spec. Depends on Batch 6 (ShiftDrawer is the Assign Staff target).

### Task 7.1 — Build a shared `KebabMenu` component

**File:** `client/src/components/adminos/KebabMenu.js` (new)

- [ ] **Step 1: Create the component.** Use a portal-positioned dropdown anchored to the trigger:

```jsx
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';

export default function KebabMenu({ items }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e) => {
      if (triggerRef.current && !triggerRef.current.contains(e.target)) {
        // Allow menu items to fire before close
        setTimeout(() => setOpen(false), 0);
      }
    };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const toggle = (e) => {
    e.stopPropagation();
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setAnchor({ top: r.bottom + window.scrollY + 4, left: r.right + window.scrollX });
    }
    setOpen(o => !o);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn kebab-trigger"
        onClick={toggle}
        title="More actions"
      >
        <Icon name="kebab" />
      </button>
      {open && createPortal(
        <div
          className="kebab-menu"
          style={{ position: 'absolute', top: anchor.top, left: anchor.left, transform: 'translateX(-100%)' }}
        >
          {items.map((item, i) => (
            <button
              key={i}
              type="button"
              className={`kebab-item ${item.danger ? 'danger' : ''}`}
              onClick={(e) => { e.stopPropagation(); setOpen(false); item.onClick(); }}
              disabled={item.disabled}
            >
              {item.icon && <Icon name={item.icon} size={13} />}
              <span>{item.label}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}
```

- [ ] **Step 2: Add CSS for KebabMenu.** Append to `client/src/index.css` admin-os section:

```css
html[data-app="admin-os"] .kebab-menu {
  background: var(--bg-elev);
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  box-shadow: var(--shadow-pop);
  min-width: 180px;
  padding: 4px 0;
  z-index: 1000;
}

html[data-app="admin-os"] .kebab-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  background: transparent;
  border: none;
  color: var(--ink-2);
  font-size: 13px;
  padding: 8px 12px;
  text-align: left;
  cursor: pointer;
}

html[data-app="admin-os"] .kebab-item:hover {
  background: var(--row-hover);
  color: var(--ink-1);
}

html[data-app="admin-os"] .kebab-item.danger {
  color: hsl(var(--danger-h) var(--danger-s) 60%);
}

html[data-app="admin-os"] .kebab-item:disabled {
  color: var(--ink-4);
  cursor: not-allowed;
}
```

---

### Task 7.2 — Build `InvoicesDrawer` (View Invoices/Payments target)

**File:** `client/src/components/adminos/drawers/InvoicesDrawer.js` (new)

- [ ] **Step 1: Create the component.**

```jsx
import React, { useEffect, useState } from 'react';
import api from '../../../utils/api';
import Drawer from '../Drawer';
import StatusChip from '../StatusChip';
import { fmt$2dp, fmtDate } from '../format';
import { useToast } from '../../../context/ToastContext';

export default function InvoicesDrawer({ proposalId, onClose }) {
  const toast = useToast();
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!proposalId) return;
    setLoading(true);
    api.get(`/invoices?proposal_id=${proposalId}`)
      .then(r => setInvoices(r.data || []))
      .catch(err => {
        console.error(err);
        toast.error("Couldn't load invoices.");
      })
      .finally(() => setLoading(false));
  }, [proposalId, toast]);

  if (!proposalId) return null;

  return (
    <Drawer onClose={onClose} title="Invoices & payments">
      {loading && <div className="drawer-loading">Loading…</div>}
      {!loading && invoices.length === 0 && <p className="empty">No invoices yet.</p>}
      {!loading && invoices.length > 0 && (
        <div className="drawer-section">
          {invoices.map(inv => (
            <a
              key={inv.id}
              href={`/invoice/${inv.token}`}
              target="_blank"
              rel="noopener noreferrer"
              className="drawer-row drawer-row-link"
            >
              <div>
                <div className="drawer-row-name">{inv.label || `Invoice #${inv.invoice_number}`}</div>
                <div className="drawer-row-meta">
                  Due {fmtDate(inv.due_date)} · {fmt$2dp(inv.amount_due)}
                </div>
              </div>
              <StatusChip kind={inv.status === 'paid' ? 'ok' : inv.status === 'partially_paid' ? 'warn' : 'neutral'}>
                {inv.status}
              </StatusChip>
            </a>
          ))}
        </div>
      )}
    </Drawer>
  );
}
```

(Verify the `/invoices?proposal_id=...` API exists. If it doesn't, look in `server/routes/invoices.js` for the right query — it may be `/proposals/:id/invoices` or similar. Adjust.)

---

### Task 7.3 — Wire kebab into EventsDashboard

**File:** `client/src/pages/admin/EventsDashboard.js`

- [ ] **Step 1: Add imports.**

```js
import KebabMenu from '../../components/adminos/KebabMenu';
import ShiftDrawer from '../../components/adminos/drawers/ShiftDrawer';
import InvoicesDrawer from '../../components/adminos/drawers/InvoicesDrawer';
import ConfirmModal from '../../components/ConfirmModal';
import { useDrawerParam } from '../../hooks/useDrawerParam';
import { useToast } from '../../context/ToastContext';
```

- [ ] **Step 2: Hooks setup inside component.**

```js
const navigate = useNavigate();  // (likely already present)
const toast = useToast();
const { drawerType, drawerId, openDrawer, closeDrawer } = useDrawerParam();
const [reminderTarget, setReminderTarget] = useState(null);  // proposal/event row for confirm modal
```

- [ ] **Step 3: Replace the existing kebab no-op.** Find line 310 (`<button ... onClick={(ev) => ev.stopPropagation()} title="More">...`). Replace the entire `<button>` with:

```jsx
<KebabMenu
  items={[
    {
      label: 'View Event',
      icon: 'eye',
      onClick: () => navigate(`/admin/events/${event.id}`),
    },
    {
      label: 'Edit Event',
      icon: 'pencil',
      onClick: () => navigate(`/admin/events/${event.id}?edit=1`),
    },
    {
      label: 'Assign Staff',
      icon: 'users',
      onClick: () => {
        const targetShiftId = (event.shifts || []).find(s => !s.fully_filled)?.id || event.shifts?.[0]?.id;
        if (!targetShiftId) {
          toast.error('No shifts on this event yet.');
          return;
        }
        openDrawer('shift', targetShiftId);
      },
    },
    {
      label: 'Send Payment Reminder',
      icon: 'mail',
      disabled: !event.proposal_id || event.payment_status === 'paid',
      onClick: () => setReminderTarget(event),
    },
    {
      label: 'View Invoices/Payments',
      icon: 'file',
      disabled: !event.proposal_id,
      onClick: () => openDrawer('invoices', event.proposal_id),
    },
  ]}
/>
```

- [ ] **Step 4: Wrap the kebab in a stop-propagation container** so clicking it doesn't fire the row navigation:

```jsx
<td onClick={e => e.stopPropagation()} className="row-actions">
  <KebabMenu items={[...]} />
</td>
```

- [ ] **Step 5: Render the drawers and confirm modal at the page bottom.**

```jsx
{drawerType === 'shift' && drawerId && (
  <ShiftDrawer shiftId={Number(drawerId)} onClose={closeDrawer} />
)}
{drawerType === 'invoices' && drawerId && (
  <InvoicesDrawer proposalId={Number(drawerId)} onClose={closeDrawer} />
)}
{reminderTarget && (
  <ConfirmModal
    title="Send payment reminder?"
    body={`Send a payment reminder to ${reminderTarget.client_name || 'the client'}? They'll get an email with a link to pay the balance.`}
    confirmLabel="Send reminder"
    onConfirm={() => {
      api.post(`/proposals/${reminderTarget.proposal_id}/send-reminder`)
        .then(() => toast.success('Reminder sent.'))
        .catch(err => toast.error(err.response?.data?.error || 'Failed to send reminder.'))
        .finally(() => setReminderTarget(null));
    }}
    onCancel={() => setReminderTarget(null)}
  />
)}
```

---

### Task 7.4 — Verify (or add) `/api/proposals/:id/send-reminder` server route

**File:** `server/routes/proposals.js`

- [ ] **Step 1: Check existing endpoints.**

```bash
grep -n 'reminder\|remind' server/routes/proposals.js
```

- [ ] **Step 2: If endpoint exists, note its exact path.** Update the client call in 7.3 step 5 to match.

- [ ] **Step 3: If endpoint does NOT exist, add a small route.** Mirror the structure of nearby routes:

```js
// POST /api/proposals/:id/send-reminder — admin sends a balance-due reminder email
router.post('/:id/send-reminder', auth, asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    throw new PermissionError('Only admins/managers can send reminders.');
  }
  const { id } = req.params;
  const { rows } = await pool.query(
    'SELECT p.*, c.email as client_email, c.name as client_name FROM proposals p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = $1',
    [id]
  );
  if (rows.length === 0) throw new NotFoundError('Proposal not found.');
  const proposal = rows[0];
  if (!proposal.client_email) throw new ValidationError('Client has no email on file.');
  // Use existing email helper — see autopayScheduler.js or similar for the reminder template
  await sendReminderEmail(proposal); // replace with the actual helper call
  await pool.query(
    "INSERT INTO proposal_activity (proposal_id, action, details, created_at) VALUES ($1, 'reminder_sent', $2, NOW())",
    [id, JSON.stringify({ by: req.user.id })]
  );
  res.json({ ok: true });
}));
```

(Verify the imports at the top of `proposals.js` include `auth`, `asyncHandler`, error classes, `pool`, `sendReminderEmail` or equivalent. Adjust the `sendReminderEmail` import to match the actual helper name in `server/utils/email.js` or `server/utils/emailTemplates.js`.)

- [ ] **Step 4: Test the route.** With dev server running, in a separate terminal:

```bash
curl -X POST http://localhost:5000/api/proposals/1/send-reminder \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json"
```

Expected: `{"ok":true}`. Check the test inbox (or Resend dashboard) for the email.

---

### Task 7.5 — Manual verify

- [ ] **Step 1: Open EventsDashboard.** `/admin/events`. Click a kebab on any row.

- [ ] **Step 2: Five-item menu appears.** All labels render. Clicking outside or pressing Esc closes the menu.

- [ ] **Step 3: View Event** navigates to `/admin/events/:id`.

- [ ] **Step 4: Edit Event** navigates to `/admin/events/:id?edit=1`. (If EventDetailPage doesn't yet honor `?edit=1` to open in edit mode, that's fine for this batch — the route is correct, the deep-link can be honored in a later polish pass.)

- [ ] **Step 5: Assign Staff** opens the ShiftDrawer for the first unfilled shift on that event. Closing the drawer returns to EventsDashboard.

- [ ] **Step 6: Send Payment Reminder** opens ConfirmModal. Cancel → modal closes, no API call. Confirm → API call → toast "Reminder sent."

- [ ] **Step 7: View Invoices/Payments** opens InvoicesDrawer. List of invoices for the proposal shown. Click a row → public invoice page opens in new tab.

- [ ] **Step 8: Disabled states.** For an event with no proposal_id, "Send Payment Reminder" and "View Invoices/Payments" are disabled (greyed, no click). Verify visually.

- [ ] **Step 9: Both skins.** Toggle to After Hours and House Lights. Menu and drawers render correctly in each.

- [ ] **Step 10: Row click still works.** Clicking the row body (not the kebab cell) still navigates to the event detail page.

---

### Task 7.6 — Commit Batch 7

- [ ] **Step 1: Stage.**

```bash
git add client/src/components/adminos/KebabMenu.js client/src/components/adminos/drawers/InvoicesDrawer.js client/src/pages/admin/EventsDashboard.js client/src/index.css server/routes/proposals.js .claude/CLAUDE.md README.md
```

(Update the folder-tree docs to add KebabMenu.js and InvoicesDrawer.js.)

- [ ] **Step 2: Commit.**

```bash
git commit -m "feat(admin-os): events dashboard kebab — 5 actions wired (view, edit, assign, remind, invoices)"
```

- [ ] **Step 3: Stand down.**

---

## Final verification (before push)

After all 7 batches commit, do a top-down sanity sweep before any push.

- [ ] **Step 1: Confirm all 14 items addressed.** Walk the spec section 6 acceptance criteria one by one. Tick each.

- [ ] **Step 2: Build clean.** Run: `cd client && npm run build`. Expected: success, no warnings about undefined variables.

- [ ] **Step 3: Smoke-test the admin shell.** Sign in as admin. Visit each of: `/admin/dashboard`, `/admin/events`, `/admin/proposals`, `/admin/clients`, `/admin/staffing`, `/admin/financials`, `/admin/marketing`, `/admin/drink-plans`, `/admin/settings`. Toggle between House Lights and After Hours on each. Toggle between Comfy and Compact on each. No console errors. No orphan-color elements.

- [ ] **Step 4: Smoke-test the staff portal.** Sign in as a staff user. Visit `/portal/dashboard`, `/portal/shifts`, `/portal/schedule`, `/portal/events`, `/portal/profile`. (Staff is intentionally unthemed in this pass — verify no regression.) Trigger a fetch failure (stop backend) and confirm a toast appears.

- [ ] **Step 5: Smoke-test public surfaces (no leakage).** While logged in as admin in After Hours, visit `/`, `/quote`, `/faq`, `/labnotes`, `/login`. All should render in their original (non-admin) styling. Inspect `<html>` — no inline `--font-*` props.

- [ ] **Step 6: Inventory commits.** Run:

```bash
git log origin/main..HEAD --oneline
```

Expected: 7 commits (one per batch).

- [ ] **Step 7: Report to user.** Tell the user the batch summary, then stand down. They issue the push cue when they're ready.

Format:
```
7 commits ready, 14 items shipped, all verified locally.
Batches: foundation, quick wins, auth+staff, density, cross-cutting, shift drawer, events kebab.
Awaiting push cue.
```

---

## Self-review notes

This plan addresses all 14 items in the spec. Coverage map:

| Spec item | Plan task |
|---|---|
| M1 — fmt$cents rename | Task 1.1 |
| C1 — font leak fix | Task 1.2 |
| H12+L1+L2 — naming + accent drift | Task 1.3 |
| C6 — Export CSV button | Task 2.1 |
| H9 — ClickableRow delete | Task 2.2 |
| H4 — InvoiceDropdown undefined tokens | Task 2.3 |
| H5 — PricingBreakdown hex | Task 2.4 |
| H2 — PaymentPanel --ms-* | Task 2.5 |
| H6 — Login redirect | Task 3.1 |
| H11 — Staff toasts | Task 3.2 |
| C7 — Density toggle | Tasks 4.1–4.3 |
| H3 — Cross-cutting (9 components) | Tasks 5.1–5.10 |
| C5 — ShiftDetail retire | Tasks 6.1–6.7 |
| H7 — Events kebab | Tasks 7.1–7.5 |

**Risks logged:** matches the spec's section 9. Cross-domain redirect, font leak verification, density migration, ShiftDetail URL preservation, H3 specificity, and Send Reminder endpoint existence — each mitigated in the corresponding task.

**Open uncertainty:** the exact API paths used by ShiftDrawer (Task 6.2) and InvoicesDrawer (Task 7.2) require reading the existing `ShiftDetail.js` and `InvoiceDropdown.js` to confirm; adjustments are part of the task. The EventDetailPage `?edit=1` deep-link (Task 7.5 step 4) might not be honored on the first pass — flagged as acceptable.

*End of plan.*
