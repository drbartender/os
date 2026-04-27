# Dr. Bartender OS — Post-Redesign Cleanup Design

**Date:** 2026-04-26
**Status:** Draft (awaiting user review before writing-plans hand-off)
**Owner:** Dallas
**Source:** Two-agent post-redesign audit (Skin Consistency + Functionality) plus product-decision Q&A

---

## 1. Background

The recent admin-os redesign introduced a two-skin theming system (`dark` / `light`), a new Sidebar/Header/Drawer/CommandPalette shell, and converted several admin pages to admin-os primitives. The redesign left behind:

- A theming gap (skin scope inconsistent; some shared components don't follow the active skin)
- A planned-but-missing density toggle
- A misleadingly named money-formatter that's a footgun for future bugs
- A handful of no-op buttons rendered as if functional
- A login redirect that creates an infinite loop on staff.drbartender.com
- Several pages still rendered in pre-redesign chalkboard chrome
- A standalone ShiftDetail page the owner never liked
- Cross-cutting components (toasts, modals, form widgets) styled for the public site that visually clash inside the admin shell, especially in dark skin

A two-agent audit identified ~50 findings. This spec covers the **14 items the owner approved for this cleanup pass.** Larger rewrites are explicitly deferred.

## 2. Scope

### In scope (14 items)

| ID | Item | Type |
|---|---|---|
| M1 | Rename `fmt$cents` → `fmt$2dp`; add `fmt$fromCents` | Refactor |
| C1 | Move font tokens from inline `<html>` styles into scoped CSS | Theme leak fix |
| C7 | Density toggle in sidebar footer + footer layout fix | Feature restore |
| H12+L1+L2 | Skin labels rename + CSS comment cleanup + accent-triple drift | Naming hygiene |
| C6 | Remove FinancialsDashboard "Export CSV" button | Cleanup |
| H6 | Login `/apply` redirect — cross-domain to hiring.* | Bugfix |
| H11 | Staff portal `useToast` on swallowed errors | UX fix |
| H4 | InvoiceDropdown `var(--sage)`/`var(--rust)` → HSL tokens | Theme fix |
| H5 | PricingBreakdown inline chalkboard hex → admin-os tokens | Theme fix |
| H2 | ProposalDetailPaymentPanel `--ms-*` fallback bugs | Theme fix |
| H9 | Delete orphan `ClickableRow.js` | Cleanup |
| H7 | Events dashboard kebab — wire 5 actions | Feature |
| C5* | Retire ShiftDetail page; migrate actions to a shift management drawer | Feature + cleanup |
| H3 | Cross-cutting component dark-skin overrides (9 components) | Theme fix |

\* C5 was originally "fix the hardcoded badges." Owner directive overrides: retire the page entirely and migrate live actions into a drawer.

### Out of scope (deferred to design-agent passes)

- **H1** — StaffLayout migration to admin-os shell (skin/density coverage on staff portal)
- **C2** — Email Marketing pages rewrite to admin-os primitives
- **C3** — RichTextEditor + Lab Notes blog admin theme migration
- **C4** — HiringDashboard, CocktailMenuDashboard, SettingsDashboard form, BlogDashboard form pre-redesign chrome
- **H8** — AdminDashboard legacy `/admin/staffing/legacy` SMS UI rewrite (will land alongside SMS-as-default messaging redesign)
- **H10** — Cocktail Menu nav resolution (currently redirects to `/admin/settings`)
- **M4** — Header notifications bell wiring
- **Clients dashboard kebab** — leave no-op as-is until designed
- **Staff dashboard kebab** — leave no-op as-is until designed

---

## 3. Naming Decisions

### Skin labels

| Layer | Dark skin | Light skin |
|---|---|---|
| User-facing UI label (sidebar toggle) | **After Hours** | **House Lights** |
| CSS section headers + inline comments in index.css | **After Hours** | **House Lights** |
| Internal data values (localStorage, CSS attribute selectors) | `'dark'` | `'light'` |

Internal `'dark'`/`'light'` strings are load-bearing — they're embedded in 100+ CSS attribute selectors (`[data-skin="dark"]`), localStorage keys, and the UserPrefsContext PALETTES map. Renaming them is a multi-day refactor that this pass explicitly avoids. The user-facing labels and CSS comments are decoupled from internal values, so renaming those is mechanical.

### Money formatter rename

`fmt$cents` is misleading — it does not divide by 100. It just formats with 2 decimal places. Per `server/db/schema.sql:478-487`, the database splits unit conventions:

- `proposals.total_price`, `proposals.amount_paid`, `proposals.deposit_amount`, all `service_packages.*_rate`/`*_fee`, `service_addons.rate`, `proposal_addons.rate` — `NUMERIC(10,2) DOLLARS`
- `stripe_sessions.amount`, `proposal_payments.amount`, `invoices.amount_due`, `invoices.amount_paid` — `INTEGER CENTS`

Current callsites use `fmt$cents` only on dollar fields, so displays are correct today. But the name implies cents handling, and the first time someone trusts it on `invoices.amount_due` we'll display 100x the real value.

**Decision:**
- Rename `fmt$cents` → **`fmt$2dp`** (two decimal places — describes what it actually does)
- Add **`fmt$fromCents(n) = '$' + (n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })`** for true integer-cents fields
- Migrate the ~10 existing callsites (all currently target dollar fields) to `fmt$2dp` — pure rename, zero behavior change

---

## 4. Per-Item Specifications

### 4.1 — M1 — `fmt$cents` → `fmt$2dp` + add `fmt$fromCents`

**Files:** `client/src/components/adminos/format.js` plus 8 callsites:
`ProposalCreate.js`, `EventDrawer.js`, `EventDetailPage.js`, `ProposalDetailPaymentPanel.js`, `FinancialsDashboard.js`, `ClientDetail.js`, `ClientDrawer.js`, `ProposalDrawer.js`.

**Design:** Pure rename + add new helper. No callsite logic changes (all current usages already target dollar fields).

**Acceptance criteria:**
- `fmt$cents` no longer exported anywhere
- All 8 callsites reference `fmt$2dp`
- New `fmt$fromCents` exported and unit-correct (`fmt$fromCents(150000)` → `"$1,500.00"`)
- No visible change to any displayed number after the change

---

### 4.2 — C1 — Font tokens leak fix

**Problem:** UserPrefsContext.js:121-125 writes `--font-ui`, `--font-display`, `--font-mono`, `--font-numeric` as inline custom properties on `<html>`. Inline styles have no scope — every public/staff/client/auth page inherits whichever skin the last admin chose (or whatever was set before logout if the strip race is lost). The non-admin surfaces are unthemed by design but currently get repainted.

**Design:**
- Remove the four `root.style.setProperty('--font-*', ...)` calls from UserPrefsContext.js:121-125
- Remove the FONTS constant from UserPrefsContext.js (it's now CSS-only)
- The font tokens are already defined in `index.css:6759-6762` (admin-os defaults) and `index.css:6855-6858` (light skin override). Both blocks are scoped under `html[data-app="admin-os"]`. Admin pages get the right fonts via CSS only.
- The PROPS list in the strip routine (UserPrefsContext.js:81-87) drops the four `--font-*` entries.

**Acceptance criteria:**
- After the change, an admin who toggles skin sees fonts swap on admin pages (verify Inter ↔ Libre Caslon Text on `.page-title`, `.kbd`, etc.)
- Public pages (`/`, `/quote`, `/faq`, `/labnotes`), client pages (`/dashboard`, `/my-proposals`), auth pages (`/login`, `/register`) render with their original fonts regardless of which skin the admin had active
- `<html>` has no inline `--font-*` properties when inspecting any page
- Sign-in / sign-out cycle does not visibly repaint non-admin pages

**Dependencies:** none. Land first.

---

### 4.3 — H12 + L1 + L2 — Skin labels + CSS comment cleanup + accent drift

**Three coupled changes, one commit:**

**(a) Sidebar UI labels — `client/src/components/adminos/Sidebar.js:84,91`:**
- Replace `>Sterile<` with `>House Lights<`
- Replace `>Experimental<` with `>After Hours<`

**(b) CSS section headers and inline comments — `client/src/index.css`:**
- Drop the orphan `LIGHT SKIN: "MAISON"` header comment at index.css:6807
- Replace "Darkroom" mentions with "After Hours" (5 sites: ~6727, plus comment headers ~7706, ~7707, ~7738, ~7760 if present)
- Replace "Atelier" mentions with "House Lights" (5 sites: ~6817 onward)
- Replace any "MAISON" mention with "House Lights"

**(c) Accent triple drift:**
- UserPrefsContext.js:8 sets `dark: { accent: { h: 212, s: 78, l: 44 } }`
- index.css:6731-6735 sets `--accent-h: 218; --accent-s: 35%; --accent-l: 40%`
- JS wins at runtime, so dark skin's actual accent is `212/78/44`. The CSS defaults are stale and misleading anyone who reads the CSS.
- Decision: update the CSS defaults at index.css:6731-6735 to match the JS values (`212`, `78%`, `44%`). Single source of truth lives in JS for now (it's per-user customizable territory), CSS reflects the same defaults.

**Files for this section:** `Sidebar.js` (label rename), `index.css` (comments + accent default values), nothing else.

**Acceptance criteria:**
- Sidebar toggle reads "After Hours" and "House Lights"
- Search the codebase for `Darkroom`, `Atelier`, `MAISON`, `Sterile`, `Experimental` — only legitimate occurrences remain (e.g., dictionary words elsewhere)
- CSS default accent triple matches JS PALETTES.dark.accent
- No runtime appearance change (just naming hygiene + a token reconciliation)

---

### 4.4 — C7 — Density toggle in sidebar footer + footer layout fix

**Problem:** Density preference is plumbed (UserPrefsContext, CSS rules at index.css:7519/7525) but no UI exists to change it. Sidebar footer is also visually cramped — current layout is two rows (collapse+skin) above a user row, with the skin toggle "mushed on top of itself" per owner.

**Design:**

Rewrite sidebar footer to four stacked rows:

```
┌─ sidebar footer ─────────────────────┐
│ [<] Collapse to rail                  │  full-width row, button + label
│ ┌─ House Lights ─┬─ After Hours ────┐ │  2-segment skin radio (rename + spacing)
│ ├────────────────┴─────────────────┤ │
│ ├─ Comfy ────────┬─ Compact ────────┤ │  2-segment density radio (NEW)
│ └────────────────┴─────────────────┘ │
├──────────────────────────────────────┤
│ (avatar) Name              [↗]        │  user row
└──────────────────────────────────────┘
```

**Density values:** Two states — `'comfy'` and `'compact'`. Drop `'normal'`. CSS already defines the two; no new CSS rules needed for density behavior.

**Migration:** On UserPrefsContext load (`load()` function), if stored `density === 'normal'` (legacy from before this change), normalize to `'comfy'`. New default for first-time users: `'comfy'`.

**`UserPrefsContext.js` changes:**
- `DEFAULT_PREFS.density = 'comfy'` (was `'normal'`)
- In `load()`, after parsing JSON, normalize: `if (parsed.density === 'normal') parsed.density = 'comfy'`

**`Sidebar.js` changes:**
- Add a second `.mode-toggle` block below the existing skin toggle, structured identically:
  ```jsx
  <div className="mode-toggle" role="radiogroup" aria-label="Density">
    <button role="radio" aria-checked={prefs.density === 'comfy'}
            className={`mode-opt ${prefs.density === 'comfy' ? 'active' : ''}`}
            onClick={() => prefs.density !== 'comfy' && setPref('density', 'comfy')}>Comfy</button>
    <button role="radio" aria-checked={prefs.density === 'compact'}
            className={`mode-opt ${prefs.density === 'compact' ? 'active' : ''}`}
            onClick={() => prefs.density !== 'compact' && setPref('density', 'compact')}>Compact</button>
  </div>
  ```
- Wrap both toggles + the collapse row in a single `.sidebar-footer-group` container with vertical spacing
- Keep the user row separate

**`index.css` changes:**
- `.mode-toggle` rules: ensure proper margin-bottom between stacked toggles (~8px gap)
- Both toggles use the same widths so they line up
- Critical: both toggles must visibly change appearance the moment they're clicked. The `.mode-opt.active` rule must use admin-os tokens that respond to `data-skin` AND `data-density` immediately:
  - `.mode-opt` background, border, text use `var(--bg-3)` / `var(--line-1)` / `var(--ink-3)` tokens (so swap with skin)
  - `.mode-opt.active` uses `var(--accent)` accent color (visible state-change marker)
- The density toggle should also visibly compact when "Compact" is clicked — its row-height/padding should respond to `data-density` so the user feels the click at the control itself.

**Acceptance criteria:**
- Density toggle present, two segments, behaves like skin toggle
- Toggling skin changes the toggle's appearance immediately (active segment border/background swaps to active skin's accent)
- Toggling density changes layout density immediately on the visible page (rows shrink/grow)
- Toggling density also visibly tightens/loosens the toggle itself (the user is staring at the button — the click feedback at the control is the first signal)
- Footer is no longer cramped: 4 stacked rows with breathing room
- Existing `prefs.density === 'normal'` localStorage entries auto-migrate to `'comfy'` on next load
- Logout strips data-density (already handled by existing strip routine)

**Dependencies:** Should land after C1 (font fix) since both touch UserPrefsContext.

---

### 4.5 — C6 — Remove FinancialsDashboard "Export CSV" button

**File:** `client/src/pages/admin/FinancialsDashboard.js:51`

**Design:** Delete the button. No replacement.

**Acceptance criteria:** No "Export CSV" button on `/admin/financials`. No regression.

---

### 4.6 — H6 — Login `/apply` redirect cross-domain

**File:** `client/src/pages/Login.js:39-42`

**Problem:** After login, code routes users with `application_status === 'in_progress'` and no application to `/apply`. On `staff.drbartender.com`, the `/apply` route doesn't exist, so the catch-all `*` redirects to `/`, which is the login screen → infinite loop.

**Design:**
- Detect host context. If `window.location.hostname.startsWith('staff.')`, send the user to `https://hiring.drbartender.com/apply` (full URL, cross-domain redirect via `window.location.assign`).
- Otherwise, current behavior (relative redirect to `/apply` on `hiring.*`, dashboard on `admin.*` or main).
- Preserve any application token / email query string if present.

**Pseudocode:**
```js
const wantsApply = ... existing logic ...;
if (wantsApply) {
  if (window.location.hostname.startsWith('staff.')) {
    const params = new URLSearchParams();
    if (user.email) params.set('email', user.email);
    window.location.assign(
      'https://hiring.drbartender.com/apply' + (params.size ? '?' + params : '')
    );
    return;
  }
  navigate('/apply');
  return;
}
```

**Acceptance criteria:**
- Logging in as an `in_progress` applicant on `staff.drbartender.com` lands them at `https://hiring.drbartender.com/apply` (not the staff dashboard, not an infinite loop)
- Logging in on `hiring.drbartender.com` still works as before (relative `/apply`)
- Logging in on `admin.drbartender.com` or main routes unaffected
- Localhost/dev: hostname doesn't start with `staff.`, so default behavior — fine

**Dependencies:** none.

---

### 4.7 — H11 — Staff portal `useToast` on swallowed errors

**Files:** `client/src/pages/staff/StaffShifts.js`, `StaffSchedule.js`, `StaffEvents.js`, `StaffDashboard.js`, `StaffProfile.js`. All five have `.catch(console.error)` patterns swallowing API failures.

**Design (per Q3 mixed pattern):**
- For **read fetches** (loading shifts, schedule, events, profile): `toast.error("Couldn't load <thing>. Try refreshing.")` — generic message
- For **write actions** (Approve/Decline shift request, Submit time-off request, Update profile, etc.): `toast.error(err.response?.data?.error || err.message || "Something went wrong.")` — surface the actual API error so the user knows what to fix on retry

Each file:
- Import `useToast` from `client/src/context/ToastContext`
- Replace `.catch(console.error)` and `.catch(err => console.error(err))` with the appropriate toast pattern

**Acceptance criteria:**
- All 5 staff pages: a network/auth/API failure shows a visible toast, not a silent blank UI
- Read-fail toasts are generic, write-fail toasts surface the API error message
- No `console.error` in production paths in these files (development logging via `console.error(err)` inside the catch is fine alongside the toast — preserves debugging)

**Dependencies:** none.

---

### 4.8 — H4 — InvoiceDropdown undefined token fix

**File:** `client/src/components/InvoiceDropdown.js:62, 73`

**Problem:** Inline styles use `var(--sage)` and `var(--rust)` which are not defined anywhere. They fall through to nothing in both skins.

**Design:**
- Line 62: `var(--sage)` → `'hsl(var(--ok-h) var(--ok-s) 52%)'` (semantic green, skin-responsive)
- Line 73: `var(--rust)` → `'hsl(var(--danger-h) var(--danger-s) 65%)'` (semantic red, skin-responsive)

**Acceptance criteria:**
- InvoiceDropdown's status colors render correctly in both skins
- No undefined CSS variables in inspect-element

**Dependencies:** none.

---

### 4.9 — H5 — PricingBreakdown inline chalkboard hex

**File:** `client/src/components/PricingBreakdown.js:18, 19, 27, 35, 40, 49`

**Problem:** Inline styles hardcode chalkboard hex colors that ignore both skins.

**Design:** Replace each hardcoded hex with the appropriate admin-os token. Specific mapping done during implementation by reading each line in context.

**Acceptance criteria:**
- PricingBreakdown renders correctly in both skins
- No hardcoded hex values remain in the file (other than ones that are intentionally non-themed, if any — none expected)

**Dependencies:** none.

---

### 4.10 — H2 — ProposalDetailPaymentPanel `--ms-*` fallback bugs

**File:** `client/src/pages/admin/ProposalDetailPaymentPanel.js:167, 243, 262`

**Problem:** Uses `var(--ms-camel, ...)`, `var(--ms-emerald, ...)`, `var(--ms-bordeaux, ...)`. These tokens are defined only in light skin (under `[data-skin="light"]`). In dark skin they fall through to the hardcoded fallback values, which are light-skin colors — wrong on a dark background.

**Design:** Convert to skin-responsive HSL form:
- `var(--ms-camel, ...)` → `'hsl(var(--warn-h) var(--warn-s) 58%)'`
- `var(--ms-emerald, ...)` → `'hsl(var(--ok-h) var(--ok-s) 38%)'` (or 52% — choose the lightness that reads correctly in both skins; tune visually)
- `var(--ms-bordeaux, ...)` → `'hsl(var(--danger-h) var(--danger-s) 50%)'`

**Acceptance criteria:**
- Payment panel renders correctly in both skins
- No `--ms-*` token references remain in the file

**Dependencies:** none.

---

### 4.11 — H9 — Delete orphan ClickableRow.js

**Files:** Delete `client/src/components/ClickableRow.js`. Update `CLAUDE.md` and `README.md` folder trees to remove the line.

**Verification before delete:** Grep `ClickableRow` across the entire codebase. Expected: zero importers. If any importer is found, surface it before deleting (might mean the audit's grep was wrong).

**Acceptance criteria:**
- File deleted
- No build errors
- Folder-tree docs updated

**Dependencies:** none.

---

### 4.12 — H7 — Events dashboard kebab menu

**Files:**
- `client/src/pages/admin/EventsDashboard.js` (line 310 today is `onClick={(ev) => ev.stopPropagation()}`)
- `client/src/components/adminos/drawers/ShiftDrawer.js` (NEW — created in 4.13 for C5; reused here for "Assign Staff")
- New utility component or inline logic for the dropdown menu

**Design:**

Replace the kebab no-op with a context menu (popover) anchored to the kebab button. Five menu items, all wired:

| Action | Behavior |
|---|---|
| **View Event** | Navigate to `/admin/events/:id` (existing EventDetailPage) |
| **Edit Event** | Navigate to `/admin/events/:id` and trigger the existing edit flow on that page (deep-link with `?edit=1` query param, EventDetailPage opens its edit form on mount when present) |
| **Assign Staff** | Open the new shift management drawer (built in 4.13) for the event's first unfilled shift (or first shift if all are filled). URL gets `?drawer=shift&drawerId=:shiftId`. The drawer is single-shift-focused — to manage a different shift on the same event, the user navigates to EventDetailPage which lists all shifts with their own Manage buttons. Closing the drawer keeps the user on EventsDashboard with their row position preserved. |
| **Send Payment Reminder** | Open ConfirmModal: "Send a payment reminder to {client.name}? They'll get an email with a link to pay the balance." On confirm, POST to existing reminder endpoint (verify endpoint exists; if not, this becomes a small server route addition); show success toast on response. |
| **View Invoices/Payments** | Open a small drawer (`InvoicesDrawer` — NEW) listing invoices for this event's proposal. Each row shows invoice number, amount, status, due date. Click an invoice row → opens `/invoice/:token` in a new tab (existing public invoice page with print/share). |

**Implementation notes:**
- Use a shared `<KebabMenu>` component (NEW) for the popover so future kebabs (Clients, Staff, when designed) reuse it. Component renders a portal-positioned dropdown anchored to the trigger button. Closes on outside click, Esc, or selection.
- Each kebab menu item is just `{ label, icon, onClick }`.
- Stop event propagation on the kebab button so row click doesn't fire.
- Verify `/api/proposals/:id/send-reminder` (or equivalent) exists. If not, add one in `server/routes/proposals.js` that fires the same email used by autopay reminders.

**Acceptance criteria:**
- Clicking the kebab opens a 5-item menu
- View Event, Edit Event, Assign Staff, Send Payment Reminder, View Invoices/Payments all functional
- ConfirmModal blocks Send Payment Reminder until confirmed
- Assign Staff drawer closes back to EventsDashboard with row position preserved
- View Invoices drawer lists invoices; click opens public invoice page in new tab
- Menu closes on outside click or Esc
- Row click still navigates to the event detail page (kebab does not interfere)

**Dependencies:** Requires ShiftDrawer (4.13) to land first for the Assign Staff entry point.

---

### 4.13 — C5 (revised) — Retire ShiftDetail, build shift management drawer

**Files:**
- DELETE: `client/src/pages/admin/ShiftDetail.js`
- ADD: `client/src/components/adminos/drawers/ShiftDrawer.js`
- MODIFY: `client/src/App.js` (route change)
- MODIFY: `client/src/pages/admin/EventDetailPage.js` (shift rows get a `[Manage]` button that opens the drawer)
- MODIFY: `client/src/components/adminos/CommandPalette.js` (if it links to ShiftDetail; remove)
- MODIFY: `CLAUDE.md`, `README.md`, `ARCHITECTURE.md` (folder-tree updates)

**Design:**

**Drawer entity (`ShiftDrawer.js`):**
Modeled after `ClientDrawer`, `EventDrawer`, `ProposalDrawer` — same `<Drawer>` primitive. The body shows:
- **Header:** Shift role + count + time + event link (e.g., "Server · 3 positions · 4–11pm — Smith Wedding (Jun 14)")
- **Requests section:** Pending applicants with [Approve] / [Decline] buttons per row. Approve assigns the staff member; Decline rejects the request.
- **Assigned section:** Currently assigned staff with [SMS] / [Remove] buttons per row. SMS opens the existing SMS send flow (legacy AdminDashboard messaging route — same as today). Remove unassigns.
- **Add staff manually:** Search/select active staff to assign directly without a request.

All actions hit the existing endpoints (`/api/shifts/:id/...`) — no new server routes. The legacy ShiftDetail.js was already calling them.

**URL handling:**
- Old route `/admin/events/shift/:id` → redirect handler in App.js: resolve the shift's parent event via `/api/shifts/:id` (existing endpoint), then `navigate(`/admin/events/${eventId}?drawer=shift&drawerId=${shiftId}`, { replace: true })`. If the API call fails (shift not found), 404 with a useful message.
- New canonical URL: `/admin/events/:eventId?drawer=shift&drawerId=:shiftId` (consumed by `useDrawerParam` hook, same pattern as other drawers)

**EventDetailPage changes:**
Each shift row in the shifts section gets a `[Manage]` button (right-aligned). Click → opens ShiftDrawer with that shift's ID.

**Hardcoded badges (C5 original):**
The "No Contract" / "No Payment" badges on the legacy ShiftDetail page disappear with the page. They were broken anyway — no migration needed.

**Acceptance criteria:**
- `/admin/events/shift/:id` no longer exists as a primary route — it redirects to the new URL form
- ShiftDetail.js file deleted; no imports broken
- EventDetailPage shift rows have a Manage button that opens the drawer
- Drawer lists requests, supports approve/decline, lists assigned staff, supports SMS + remove + manual add
- All actions work end-to-end (verified manually in dev against test data)
- Closing the drawer leaves user on EventDetailPage with scroll position preserved
- Folder-tree docs updated (CLAUDE.md, README.md, ARCHITECTURE.md)

**Dependencies:** Drawer is a new pattern, but `<Drawer>` primitive at `components/adminos/Drawer.js` already exists. No new infrastructure.

---

### 4.14 — H3 — Cross-cutting component dark-skin overrides

**Components in scope (locked at 9):**
1. Toast (`client/src/components/Toast.js`)
2. ConfirmModal (`client/src/components/ConfirmModal.js`)
3. FormBanner (`client/src/components/FormBanner.js`)
4. FieldError (`client/src/components/FieldError.js`)
5. FileUpload (`client/src/components/FileUpload.js`)
6. TimePicker (`client/src/components/TimePicker.js`)
7. NumberStepper (`client/src/components/NumberStepper.js`)
8. LocationInput (`client/src/components/LocationInput.js`)
9. InvoiceDropdown (`client/src/components/InvoiceDropdown.js`) — already partially handled by 4.8 (H4); the dark-skin override is the remaining piece

**Design pattern:**

For each component's existing CSS rules in `index.css`:
- Keep the existing rules (those serve public/client/auth contexts — no change there)
- Add a parallel block scoped to `[data-app="admin-os"]` that uses admin-os tokens

**Example (Toast):**
```css
/* Existing — unchanged, applies on public/client/auth pages */
.toast-success { background: #f7f4ec; color: #3d3a33; border: 1px solid #ece6d4; }

/* New — applies inside admin shell only, swaps with skin */
[data-app="admin-os"] .toast-success {
  background: var(--bg-1);
  color: var(--ink-1);
  border: 1px solid var(--ok-line, hsl(var(--ok-h) var(--ok-s) 35%));
}

[data-app="admin-os"] .toast-error {
  background: var(--bg-1);
  color: var(--ink-1);
  border: 1px solid hsl(var(--danger-h) var(--danger-s) 50%);
}

[data-app="admin-os"] .toast-info {
  background: var(--bg-1);
  color: var(--ink-2);
  border: 1px solid hsl(var(--info-h) var(--info-s) 45%);
}
```

Same pattern for the other 8 components — read each one's existing CSS, identify the colors/borders/shadows that need to swap with skin, write a parallel `[data-app="admin-os"]` block.

**Token mapping cheat sheet (all skin-responsive):**
- Container background: `var(--bg-1)` (cards), `var(--bg-2)` (rows), `var(--bg-3)` (inputs), `var(--bg-elev)` (modals/overlays)
- Border: `var(--line-1)` (subtle), `var(--line-2)` (table), `var(--line-3)` (strong)
- Text: `var(--ink-1)` (primary), `var(--ink-2)` (secondary), `var(--ink-3)` (muted), `var(--ink-4)` (placeholder)
- Accent: `var(--accent)`, `var(--accent-soft)`, `var(--accent-line)`
- Semantic: `hsl(var(--ok-h) var(--ok-s) 50%)`, `hsl(var(--danger-h) var(--danger-s) 50%)`, etc.
- Shadows: `var(--shadow-card)`, `var(--shadow-pop)`, `var(--glow)`

**Acceptance criteria:**
- All 9 components render correctly in both skins inside the admin shell
- All 9 components render unchanged outside the admin shell (public/client/auth)
- Toggling skin updates all 9 components on visible pages immediately, with no FOUC or flicker
- Verified on at least one admin page each: Toast (any save action), ConfirmModal (delete confirm), FormBanner (form error), FieldError (form validation), FileUpload (W9 upload page), TimePicker (proposal create), NumberStepper (proposal create), LocationInput (proposal create address field), InvoiceDropdown (proposal payment panel)
- Public pages spot-checked to confirm no visual regression: Toast (form-submit on quote wizard), ConfirmModal (logout from client portal), FileUpload (none on public — N/A), TimePicker (book-a-class), etc.

**Dependencies:** Light dependency on H4 (InvoiceDropdown undefined tokens — fix those first, then add the dark-skin override). Otherwise independent.

---

## 5. Sequencing & Batching

Per the project's trunk-only workflow, each batch ships as one or more commits and one push. Pre-Push Procedure runs the 5 review agents per push. Owner issues push cues; agent does not auto-push.

| Batch | Items | Risk | Notes |
|---|---|---|---|
| **B1 — Foundation** | M1 (rename), C1 (font fix), H12+L1+L2 (naming hygiene) | Low | Mechanical, no UI behavior change. Establishes correct naming + cleans the global font leak. |
| **B2 — Quick wins** | C6 (Export CSV), H9 (ClickableRow), H4 (InvoiceDropdown), H5 (PricingBreakdown), H2 (PaymentPanel) | Low | Targeted fixes, each touches one file (or one + delete). |
| **B3 — Auth + staff** | H6 (Login redirect), H11 (staff toasts) | Low | One file + five files respectively. Affects auth flow — verify by attempting login as in_progress applicant on staff.* (or simulate via hostname spoof) before push. |
| **B4 — Density toggle** | C7 (density + footer layout) | Medium | Touches UserPrefsContext + Sidebar + index.css. Visual change. Requires manual testing of skin/density toggling on multiple admin pages. |
| **B5 — Cross-cutting** | H3 (9 components) | Medium | Many files. CSS-only changes. Requires verification on both skins across multiple admin pages and at least one public page each (no regression). |
| **B6 — Shift drawer** | C5 (drawer build, ShiftDetail retirement) | Medium-High | Drawer is new code; route redirect is real surgery. Must verify no broken links, request/assignment actions still work, SMS still fires, manual-add still works. |
| **B7 — Events kebab** | H7 (5 actions wired) | Medium | Depends on B6 (Assign Staff opens the drawer from B6). Adds new KebabMenu component, ConfirmModal usage, InvoicesDrawer. |

Independent reviewer agents run on each push. Items don't strictly require this ordering, but B1 → B7 sequences low-risk-first and respects dependencies (B7 needs B6).

---

## 6. Acceptance Criteria (Whole Spec)

The cleanup is complete when:

1. All 14 items shipped and merged to `main`
2. No console errors on any admin or staff page after the changes
3. Toggling between House Lights and After Hours on any admin page produces an immediate, complete visual swap with no FOUC, no orphan-color elements, no missing tokens
4. Toggling Comfy / Compact density on any admin page produces an immediate spacing change
5. Both toggles' own appearance change visibly when clicked (the click feedback at the control itself, since the user is looking at it)
6. Public marketing, client portal, auth, onboarding pages render unchanged from before the cleanup (no theme leakage either way)
7. Staff portal pages still render with their current legacy classes and now show error toasts on API failures
8. ShiftDetail page is gone; old URLs redirect to the new drawer URL form
9. EventsDashboard kebab opens a real menu with five working actions
10. `fmt$cents` no longer exists; only `fmt$`, `fmt$2dp`, and `fmt$fromCents`
11. `<html>` has no inline `--font-*` properties on any page
12. Sidebar UI labels read "House Lights" and "After Hours"
13. CLAUDE.md, README.md, ARCHITECTURE.md folder trees updated for ClickableRow + ShiftDetail removals and ShiftDrawer + KebabMenu + InvoicesDrawer additions

---

## 7. Testing Strategy

Per the project's vibe-coded convention: manual testing in dev (`npm run dev`) before each push.

**Per batch:**
- Run lint/build (already enforced by lint-staged + pre-commit hook)
- Manually exercise the touched feature on the golden path
- Toggle skin and density on every page touched (B4 onward)
- Run the 5 review agents via Pre-Push Procedure (consistency-check, code-review, security-review, database-review, performance-review)

**Cross-batch regression spot-check before final push:**
- Walk through Events / Proposals / Clients / Staff dashboard, EventDetailPage, ProposalDetail, FinancialsDashboard
- Walk through one staff portal page (StaffShifts) to verify toasts fire on simulated failure
- Walk through one public page (HomePage), one client page (ClientDashboard), one auth page (Login) to verify no theme leakage
- Toggle skin + density on each — verify immediate response

---

## 8. Out-of-Scope and Why

These items came up in the audit but are deferred:

| Item | Why deferred |
|---|---|
| StaffLayout migration to admin-os shell | Owner: "design agent later" — needs design judgment on how staff portal should look in both skins |
| Email Marketing rewrite | Owner: "design agent later" — large surface, needs design pass |
| RichTextEditor + Lab Notes blog admin | Owner: "design agent later" — TipTap themeing is non-trivial |
| HiringDashboard, CocktailMenuDashboard, SettingsDashboard form, BlogDashboard form | Owner: "design agent later" |
| AdminDashboard legacy SMS UI rewrite | Owner: SMS becoming primary messaging tool — landing with the eventual messaging redesign, not a piecemeal port |
| Cocktail Menu nav resolution | Owner: "design agent later" — needs decision on whether Cocktail Menu deserves its own page or stays a Settings tab |
| Header notifications bell | Owner: "design agent later" — needs notifications inbox design |
| Clients dashboard kebab | Owner: leave alone for now |
| Staff dashboard kebab | Owner: leave alone for now |
| `[data-sidebar="hidden"]` mode | Low priority — supported in CSS, no UI to enter; leave dead code for now |
| `window.confirm` → ConfirmModal across 5 pages | Low-priority polish, not in this pass |
| `fmt$cents` callsite migration to `fmt$2dp` includes the rename in M1; no further callsite work needed |

---

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Cross-domain redirect (H6) fails in dev because localhost doesn't have separate hosts | Hostname check is null-safe; localhost falls through to relative `/apply` (existing behavior). Verify by setting `HOST=staff.drbartender.com` in `/etc/hosts` for a local test. |
| Font leak fix (C1) accidentally regresses admin font swap (Inter ↔ Libre Caslon) | Both skins' font tokens already exist in scoped CSS (index.css:6759-6762, 6855-6858). Removing the JS inline-write doesn't remove the values — CSS still works. Verify by reading `getComputedStyle(document.querySelector('.page-title')).fontFamily` after the change in both skins. |
| Density toggle migration breaks existing admin sessions | Migration is read-time (in `load()`), not write-time. Old `'normal'` reads as `'comfy'` automatically. localStorage is also keyed per-user, so each admin migrates independently on next load. |
| ShiftDetail retirement (C5) breaks deep links (emails, browser bookmarks) | The redirect handler in App.js resolves shift→event via existing API, then redirects to canonical drawer URL. Old links land in the right place. |
| H3 cross-cutting overrides cause specificity wars | Existing rules use single-class selectors. New rules use `[data-app="admin-os"]` prefix → higher specificity, so the override wins inside the admin shell. Outside, the original wins. Verify with browser inspector. |
| Events kebab Send Payment Reminder lacks a server endpoint | Audit didn't surface one explicitly. Verify before B7: grep `server/routes/proposals.js` for `reminder`. If not present, add a small endpoint that calls the existing reminder email helper. Treat as part of B7. |

---

## 10. Open Questions (resolved during brainstorming)

All product decisions are locked. No open questions remain. The only remaining product decision is whether to spawn writing-plans for the execution plan now or after a final spec review.

---

*End of spec.*
