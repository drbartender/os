# Admin UI Revamp — Deferred Surfaces

> **For follow-up sessions:** Each surface below was deferred during the bulk admin-os revamp on 2026-04-24. They function correctly with the existing CSS but look stylistically out of place inside the new Admin OS shell. Each one deserves a dedicated session.
>
> **Hand this file (plus the spec + plan) to a fresh Claude session to pick up where we left off.**

**Spec:** `docs/superpowers/specs/2026-04-24-admin-ui-revamp-design.md`
**Plan:** `docs/superpowers/plans/2026-04-24-admin-ui-revamp.md`
**Handoff bundle (v2):** `C:\Users\dalla\Downloads\Dr Bartender-handoff (2)\dr-bartender\project\admin-os\`
**Design system entry points:** `client/src/components/adminos/` and the `Admin OS` block in `client/src/index.css`

---

## How to start a dedicated session

Open Claude Code in this repo and tell it something like:

> Pick up the admin UI revamp from `docs/superpowers/plans/2026-04-25-admin-ui-revamp-deferred-surfaces.md`. Today I want to handle **<surface>** — read its entry in that doc, then read the existing file and the matching handoff design file, and rewrite it in the new vocabulary while preserving every existing handler / API call / business rule. Run `cd client && npm run build` after the rewrite, then commit.

Then proceed surface-by-surface. Each entry below tells you which handoff file to mirror, where the heavy state lives, and what to be careful about.

---

## 1. ProposalDetail.js — biggest single rewrite

**File:** `client/src/pages/admin/ProposalDetail.js` (2386 LOC)
**Route:** `/admin/proposals/:id`
**Handoff design:** `detail-pages.jsx` `ProposalDetailPage` (lines 10–269) and `proposal-detail.jsx` (302 LOC alternative version with Editor ↔ Client preview seg)
**Drawer (already built):** `client/src/components/adminos/drawers/ProposalDrawer.js`

**State surface area (don't lose any of these):**
- Proposal load + edit form (line items, addons, syrups, packages, num_bartenders, num_bars, adjustments)
- Notes (admin_notes, save handler)
- Public link copy + payment link generation
- Balance due date + autopay configuration
- Charge balance / record payment (cash/card/check, paid-in-full toggle)
- Drink plan integration (event context only)
- Shift/staffing (event context only) — manual assign, auto-assign preview/confirm, equipment config, setup minutes, requests approval/denial
- Invoice creation + InvoiceDropdown
- Activity log popup
- Edit-mode dirty-tracking + leave-confirm modal

**Load-bearing rules to grep before touching:**
- `isHostedPackage` from `server/utils/pricingEngine.js` — additional bartenders are $0 on hosted packages (CLAUDE.md "Hosted-package bartender rule")
- `getEventTypeLabel` from `client/src/utils/eventTypes.js` — never concat `event_type` and `event_type_custom` manually

**Approach:**
1. Don't rewrite from scratch — keep all state, hooks, handlers intact.
2. Replace outer wrapper `page-container wide` → `page` (max-width 1280).
3. Add identity bar card at top per handoff `detail-pages.jsx` lines 27–56: status chip + package tag + actions row (Copy link / Resend / Mark accepted) + segmented control (Editor ↔ Client preview).
4. Wrap the existing two-column layout in the design's `display: grid; gridTemplateColumns: '1fr 320px'`.
5. Restyle inner forms: `form-input` → `input`, `form-select` → `select`, `form-textarea` → `textarea` styled like `input`, `form-label` → `meta-k`, `admin-table` → `tbl`, `badge ...` → `<StatusChip kind="...">`.
6. Verify each existing flow still works: edit, save, send, resend, mark accepted, capture payment, autopay, generate payment link, create invoice, send to client.

**Shape of "Editor" vs "Client preview" seg:**
The handoff has a segmented control that toggles between admin-facing edit view and the public proposal preview. Reuse `<ProposalView>` (the public component at `client/src/pages/proposal/ProposalView.js`) for the preview tab, or render an inline read-only copy.

---

## 2. ProposalCreate.js — multi-step wizard

**File:** `client/src/pages/admin/ProposalCreate.js`
**Route:** `/admin/proposals/new`
**Handoff design:** `proposal-create.jsx` (407 LOC)

**Steps (handoff line 15):** `['Client', 'Event', 'Package & drinks', 'Staffing', 'Pricing', 'Review & send']`

**Layout from handoff:**
- Left column: sticky `Stepper` card with the 6 steps and progress
- Right column: `StepBody` rendering one of `ClientStep`, `EventStep`, `PackageStep`, `StaffingStep`, `PricingStep`, `ReviewStep`

**Approach:**
1. Read existing `ProposalCreate.js` to inventory state. Likely shares the same client-search, package-selection, pricing-engine integration as the live proposal.
2. Port the StepperWizard layout from handoff `proposal-create.jsx` lines 73–104.
3. Each Step component preserves the existing logic for that step's fields. Restyle per `proposal-create.jsx` lines 142–295.
4. Pricing math must match `PricingStep` exactly — same package selection, addons, syrups, num_bartenders override (with hosted-package $0 rule), adjustments, total override.

**Watch for:** the `?client_id=…` query param the new ClientDrawer / ClientDetail send when "New proposal" is clicked from a client surface — pre-populate the Client step.

---

## 3. AdminUserDetail.js — staff member profile

**File:** `client/src/pages/AdminUserDetail.js` (940 LOC)
**Route:** `/admin/staffing/users/:id`
**Handoff design:** `staff-detail.jsx` `StaffDetailPage` (lines 7–123)

**State surface area:**
- Profile load (contractor_profile, applications, agreements, onboarding_progress, payday_protocols)
- Edit profile (preferred_name, phone, city, state, travel_distance, transportation, equipment, sizes, etc.)
- W-9 status — view/approve/reject signed agreements
- Payouts — manage, view history
- Role management — promote to manager, set can_staff
- Shift history (list of past + upcoming events the user worked)
- Deactivate / reactivate
- Reset password

**Approach:**
1. Replace outer `page-container` → `page`, add identity-bar card (avatar + name + status chip + role + role-action buttons).
2. Restructure as 2-column: left = sections (Profile, Equipment, Performance, Schedule, Documents/W-9), right = Stat row + Actions card.
3. Restyle every form section per Admin OS vocab.
4. Preserve every action (approve W-9, manage payouts, set role, deactivate, reset password, edit profile, upload docs).

---

## 4. AdminApplicationDetail.js — applicant review

**File:** `client/src/pages/AdminApplicationDetail.js` (555 LOC)
**Route:** `/admin/staffing/applications/:id`
**Handoff design:** `staff-detail.jsx` `ApplicationDetailPage` (lines 127–239)

**Stages (handoff line 125):** `['Applied', 'Screen', 'Interview', 'Trail shift', 'Offer', 'Rejected']`

**State surface area:**
- Application load + applicant profile
- References
- Notes
- Approve / reject / convert to staff
- Stage advancement
- Sample shift sign-up

**Approach:**
1. Identity bar with applicant name + stage stepper (use the design's stage progression visual).
2. Sections: Applicant details, Positions interested, Equipment, References, Notes, Activity.
3. Right column: Actions card (Advance stage / Reject / Convert) + Stat card (applied date, days in stage).
4. Preserve approve/reject/convert business logic exactly — these touch user creation flows.

---

## 5. HiringDashboard.js — kanban pipeline

**File:** `client/src/pages/admin/HiringDashboard.js` (448 LOC)
**Route:** `/admin/hiring`
**Handoff design:** `pages.jsx` `HiringPage` (lines 356–386) — simple 4-card kanban

**State surface area:**
- Two tabs: Applications + Onboarding users (with separate fetch/filter/page state for each)
- Inline status editing (click status badge → dropdown)
- Pagination
- Status filters (applied / interviewing / hired / archived) for apps; (in_progress / hired / deactivated) for users

**Tradeoff to decide:**
- The handoff design is a 4-card kanban (Applied / Interview / Offer / Onboarding). The existing dashboard is a tabbed table. The kanban is more visual but loses pagination + inline editing.
- **Recommended:** keep the two-tab structure but restyle each table in new vocab; add a kanban view-mode toggle later if you actually use it.

**Approach:**
1. `page-header` with title + subtitle + actions (Export, "Open role" if you add that).
2. `Toolbar` with the existing tab control (Applications / Onboarding) — use `<Toolbar>` from `components/adminos/Toolbar.js` with custom tabs.
3. Each tab renders a `.tbl` with the existing data + filter selects in the toolbar's `filters` slot.
4. Inline status editing: on status-cell click, open a small dropdown (existing logic) — keep the dropdown styling consistent with `select.select`.
5. Onboarding progress bar in the user table → use the design's `.bar` + `.bar-fill`.

---

## 6. Email Marketing subsystem (8 pages)

**Files (1174 LOC total):**
- `EmailMarketingDashboard.js` (37) — hub with NavLink tabs + Outlet
- `EmailLeadsDashboard.js` (179)
- `EmailLeadDetail.js` (196)
- `EmailCampaignsDashboard.js` (95)
- `EmailCampaignDetail.js` (301)
- `EmailCampaignCreate.js` (128)
- `EmailAnalyticsDashboard.js` (88)
- `EmailConversations.js` (150)

**Routes:** all under `/admin/email-marketing/*`
**Handoff design:** `email-marketing.jsx` (910 LOC) — has all 8 page components

**Why coordinated:**
- They share `em-*` CSS classes (em-dashboard, em-tabs, em-table, em-badge, em-row-clickable, em-pagination, em-filters, em-form-grid, etc.) defined in `client/src/index.css`. Rewriting one page leaves the others mismatched. Do all 8 in one session.
- The hub uses a nested `<Outlet />` — restyle the tab nav to use `.seg` and the wrapping `card` to use Admin OS card.

**Approach for the session:**
1. Replace `em-dashboard card` outer with `.page` + `.page-header` + `.seg` for tab nav.
2. Each child page: `.em-table` → `.tbl`, `.em-badge` → `<StatusChip>`, `.em-filters` → `<Toolbar>`, `.em-create-form` → cards w/ new vocab inputs.
3. Add `LeadDrawer` per spec Q6 — quick-peek for lead rows (port pattern from existing drawers).
4. Verify every CRUD flow: create lead, import CSV, send campaign, schedule, view conversation thread, send reply.
5. Delete obsolete `em-*` CSS rules from `index.css` after migration.

**Endpoints (existing, unchanged):**
- `GET /api/email-marketing/leads`, `POST`, `GET /:id`, `PATCH /:id`, `DELETE /:id`
- `GET /api/email-marketing/campaigns`, `POST`, `GET /:id`, `POST /:id/send`, `POST /:id/test-send`
- `GET /api/email-marketing/conversations`, `POST /:id/reply`
- `GET /api/email-marketing/analytics`

---

## 7. CocktailMenuDashboard.js — drink library

**File:** `client/src/pages/admin/CocktailMenuDashboard.js` (932 LOC)
**Route:** currently `/admin/cocktail-menu` redirects to `/admin/settings` and embeds this as a tab; sidebar "Cocktail Menu" item lands there.
**Handoff design:** `drink-library.jsx` `DrinkLibraryPage` (lines 63–225)

**State surface area:**
- DrinkTable with drag-and-drop reordering (uses `dataTransfer` API)
- Per-spirit category tabs (Vodka / Gin / Rum / Tequila / Whiskey / Scotch / Bourbon / Mezcal / Cognac / Amaretto / Aperol / Other)
- Inline edit (name, ingredients, glassware, base spirit, slug)
- Activate/deactivate toggle
- Image upload
- New drink form

**Approach:**
1. Keep CocktailMenuDashboard.js as the Drink Library; rewrite using the design's card-grid layout from `drink-library.jsx`.
2. Add a new route `/admin/cocktail-menu` → CocktailMenuDashboard (no longer embedded in Settings).
3. Update `client/src/components/adminos/nav.js` to keep "Cocktail Menu" pointing at the new route (already does).
4. Move Settings's drink-menu tab to point at this same component, OR drop the tab from Settings.
5. Replace `data-table` → `tbl`, `form-input` → `input`, etc.
6. Drag-drop reordering: keep the existing `dataTransfer` logic; just restyle the row.

---

## 8. CSS Cleanup (Phase 10 sweep)

After all 7 surfaces above are rewritten, clean up dead styles:

```bash
# Find still-referenced legacy admin CSS classes
grep -rn "className.*admin-\|className.*em-\|className.*blog-\|className.*tab-nav\|className.*dashboard-stats\|className.*dashboard-stat-card\|className.*data-table" client/src/pages client/src/components | grep -v adminos
```

Once each surface stops referencing a class, delete its rule from `client/src/index.css`. Specifically:
- `.admin-page`, `.admin-shell`, `.admin-sidebar*`, `.admin-nav-*`, `.admin-content`, `.admin-grid`, `.admin-table`, `.admin-sidebar-toggle`, `.admin-sidebar-overlay` (lines ~71–75, 826–831, 1045–1104, 1219–1370 of pre-revamp index.css)
- `.em-*` block (whatever lines they live at)
- `.blog-*` block (cover-image-preview, status-pill, etc.)
- `.dashboard-stats`, `.dashboard-stat-card`, `.tab-nav`, `.tab-btn` if no public surfaces use them
- `.event-header`, `.event-tags`, `.event-columns`, `.event-meta-row`, etc. — used only by ProposalDetail; delete after item 1 above

**Files to delete entirely:**
- `client/src/pages/AdminDashboard.js` — once messaging UX is ported elsewhere (the `/admin/staffing/legacy` route can stay until then)
- `client/src/pages/admin/CocktailMenuDashboard.js` — only if you build a fresh Drink Library and don't reuse this. Otherwise keep + restyle per item 7.

**Documentation updates** (per CLAUDE.md mandatory rule):
- `CLAUDE.md` — folder tree under `client/src/components/` to add `adminos/` subfolder; remove `AdminBreadcrumbs.js`; add `EventDetailPage.js`, `StaffDashboard.js`
- `README.md` — same folder tree updates; add Admin OS to Tech Stack notes
- `ARCHITECTURE.md` — new "Admin OS" section describing the shell, drawers, skin/density/sidebar prefs, palette tokens

Each rewrite session should add a line to `CLAUDE.md` so the cleanup tail is small.

---

## Suggested order

When you do these in dedicated sessions, suggested order (lightest first):

1. **HiringDashboard** — 448 LOC, well-bounded
2. **AdminApplicationDetail** — 555 LOC, follows handoff `staff-detail.jsx` closely
3. **AdminUserDetail** — 940 LOC, similar pattern to ApplicationDetail
4. **CocktailMenuDashboard** — 932 LOC, mostly tabular + drag-drop
5. **Email Marketing 8-pack** — 1174 LOC across 8 files, coordinate as one session
6. **ProposalCreate** — 6-step wizard, requires careful pricing-engine handling
7. **ProposalDetail** — biggest, save for last when you're warmed up

Each is roughly a 1–2 hour Claude session if the rewrite stays focused on JSX/CSS and preserves underlying logic.

After all 7: run the cleanup sweep (item 8). Then run the 5 review agents on the full diff before pushing.
