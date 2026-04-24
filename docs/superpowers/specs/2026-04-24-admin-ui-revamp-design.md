# Admin UI Revamp — Dr. Bartender OS

**Date:** 2026-04-24
**Status:** Design approved — ready for implementation plan
**Source:** `C:\Users\dalla\Downloads\Dr Bartender-handoff (2)\dr-bartender\project\admin-os\`

## Overview

Full big-bang replacement of the `/admin/*` UI with a new design system ("Dr. Bartender OS"), delivered as an HTML/CSS/JSX prototype bundle. Every existing admin surface is rewritten in the new vocabulary: shell (sidebar + header + main), design tokens, component library, two skins, and a full set of mocked page layouts.

Admin-only. Staff portal (`staff.drbartender.com`), public site, client portal — all unchanged.

## Decisions (locked from brainstorming Q&A)

| # | Decision |
|---|---|
| 1 | **Full big-bang rewrite.** Rip out `AdminLayout` + `.admin-*` styles. Not launched yet, so the admin can go partly-dark mid-flight. |
| 2 | **Drawer for peek, full page for edit.** Row click opens a right-slide drawer with a hero summary and actions; drawer has an "Open page" button that navigates to the full detail route. Drawer state syncs to URL (`?drawer=kind&id=…`) so deep links work. |
| 3 | **Skin: per-user, persisted, default Darkroom (dark).** localStorage key per logged-in user. Sidebar-footer toggle stays. |
| 4 | **Density + sidebar: per-user prefs.** Density = compact / normal / comfy. Sidebar = **full ↔ rail** (icons-only collapse — no "hidden" state). Font locked to **Inter × JetBrains Mono**. No floating Tweaks FAB. |
| 5 | **Cmd+K palette — skeleton only.** Jump-to and Create groups live; Records group stubbed for a follow-up that adds a real `GET /api/admin/search` endpoint. |
| 6 | **Freestyle + extend drawers.** Use the handoff designs verbatim for everything they cover. Freestyle only **Blog admin** and **Settings** in the new vocabulary. Extend the drawer pattern to **Email Leads**, **Drink Plans**, and **Shifts** (so every list has a row-click peek). |

## Architecture

### Shell (replaces `AdminLayout`)

CSS grid: `sidebar (220px, 54px when rail) | header (44px) + main`.

- **Sidebar** — brand mark, nav grouped into three sections (Workspace / Revenue / Content), rail collapse button in the footer, Sterile/Experimental skin toggle, user avatar + sign-out.
- **Header** — breadcrumbs ("Workspace / <Page> / <Record>"), wide `⌘K` search button, notification bell (with dot when unread), quick-add `+` button.
- **Main** — `<Outlet />` with `scroll-thin` scrollbar.

Nav groups (badge counts fed from existing `/api/admin/badge-counts`):

| Section | Items |
|---|---|
| **Workspace** | Dashboard · Events · Proposals · Clients · Staff · Hiring |
| **Revenue** | Financials · Marketing |
| **Content** | Cocktail Menu · Lab Notes (Blog) · Settings |

### User preferences

New `UserPrefsContext` (client/src/context/UserPrefsContext.js):

```js
{ skin: 'dark' | 'light',
  density: 'compact' | 'normal' | 'comfy',
  sidebar: 'full' | 'rail' }
```

- Hydrated from `localStorage["drb-admin-prefs-" + userId]` on mount (defaults if unset: `{ skin: 'dark', density: 'normal', sidebar: 'full' }`).
- Written on every change.
- Applied to `document.documentElement` via `data-skin` / `data-density` / `data-sidebar` so the CSS selectors in styles.css work unchanged.
- Palette tokens (accent / ok / warn / danger / info / violet) swap based on skin via the same `useEffect` the bundle uses in `index.html`.

### Drawers (new shared pattern)

`<Drawer>` primitive (scrim + right-slide panel, `open` prop, Esc/scrim-click close). Instantiated once per kind:

- `EventDrawer`, `ProposalDrawer`, `ClientDrawer` — designed in handoff.
- `LeadDrawer`, `DrinkPlanDrawer`, `ShiftDrawer` — freestyle in the same vocab (hero chips + title + meta grid + section-title/dl + activity + actions row).

Drawer state lives in a `useSearchParams` hook: `?drawer=event&id=e2`. This gives us shareable peek links and browser back/forward.

Every drawer has an **Open page** button in the `drawer-head` that navigates to the full detail route.

### Command palette

Global `⌘K` / `Ctrl+K`:

- **Jump to** — 9 nav destinations (navigation via `useNavigate`).
- **Create** — New proposal, New event, New client (navigates to create routes where they exist; stubbed where not).
- **Records** — hardcoded demo rows for now with a TODO comment pointing at the follow-up API.

Esc closes. Shared `palette-*` styles from bundle CSS.

### Routes

Keep the existing `/admin/*` tree. Add:

- `/admin/cocktail-menu` → new `CocktailMenuDashboard` (currently redirects to settings).
- Event Detail (`/admin/events/:id`) currently reuses `ProposalDetail` — split into a real `EventDetailPage` that folds in shift management (so `/admin/events/shift/:id` → redirect to parent event, or stays as a drawer-peek).

Drawer URLs (`?drawer=...&id=...`) layer on top of any route.

## Pages in scope

| # | Route | Status in design | New component |
|---|---|---|---|
| 1 | `/admin/dashboard` | Fully designed | `Dashboard` rewrite |
| 2 | `/admin/events` | Fully designed | `EventsDashboard` rewrite + `EventDrawer` |
| 3 | `/admin/events/:id` | Fully designed | New `EventDetailPage` (folds in shift detail) |
| 4 | `/admin/proposals` | Fully designed | `ProposalsDashboard` rewrite + `ProposalDrawer` |
| 5 | `/admin/proposals/:id` | Fully designed | `ProposalDetail` rewrite (Editor ↔ Client preview seg) |
| 6 | `/admin/proposals/new` | Fully designed | `ProposalCreate` rewrite (6-step wizard) |
| 7 | `/admin/clients` | Fully designed | `ClientsDashboard` rewrite + `ClientDrawer` |
| 8 | `/admin/clients/:id` | Fully designed | `ClientDetail` rewrite |
| 9 | `/admin/staffing` | Fully designed | Staff list page (existing `AdminDashboard` replaced) |
| 10 | `/admin/staffing/users/:id` | Fully designed | `AdminUserDetail` rewrite (→ `StaffDetailPage`) |
| 11 | `/admin/staffing/applications/:id` | Fully designed | `AdminApplicationDetail` rewrite (→ `ApplicationDetailPage`) |
| 12 | `/admin/hiring` | Fully designed | `HiringDashboard` rewrite (kanban pipeline) |
| 13 | `/admin/financials` | Fully designed | `FinancialsDashboard` rewrite |
| 14 | `/admin/drink-plans` | Fully designed | `DrinkPlansDashboard` rewrite + `DrinkPlanDrawer` |
| 15 | `/admin/drink-plans/:id` | Fully designed | `DrinkPlanDetail` rewrite |
| 16 | `/admin/cocktail-menu` | Fully designed | New `CocktailMenuDashboard` (Drink Library) |
| 17 | `/admin/email-marketing` | Fully designed | `EmailMarketingDashboard` rewrite (hub) |
| 18 | `/admin/email-marketing/leads` | Fully designed | `EmailLeadsDashboard` rewrite + `LeadDrawer` |
| 19 | `/admin/email-marketing/leads/:id` | Fully designed | `EmailLeadDetail` rewrite |
| 20 | `/admin/email-marketing/campaigns` | Fully designed | `EmailCampaignsDashboard` rewrite |
| 21 | `/admin/email-marketing/campaigns/:id` | Fully designed | `EmailCampaignDetail` rewrite |
| 22 | `/admin/email-marketing/campaigns/new` | Fully designed | `EmailCampaignCreate` rewrite |
| 23 | `/admin/email-marketing/analytics` | Fully designed | `EmailAnalyticsDashboard` rewrite |
| 24 | `/admin/email-marketing/conversations` | Fully designed | `EmailConversations` rewrite |
| 25 | `/admin/blog` | **Freestyle** | `BlogDashboard` rewrite — table-of-posts + editor modal/route. |
| 26 | `/admin/settings` | **Freestyle** | `SettingsDashboard` rewrite — card grid of setting groups (Team, Branding, Billing, Integrations). |

Removed / collapsed:
- `AdminBreadcrumbs` component — replaced by the inline `header-crumbs` in the new Header.
- `/admin/events/shift/:id` route — the new `EventDetailPage` renders staffing inline; shift routes remain as deep-link fallbacks but render a `ShiftDrawer` over the Event page.

## Shared components

Under `client/src/components/adminos/`:

| Component | Purpose |
|---|---|
| `Sidebar` | Nav + user footer + skin toggle + rail collapse |
| `Header` | Breadcrumbs + palette launcher + actions |
| `CommandPalette` | `⌘K` global modal |
| `Drawer` | Shared right-slide primitive |
| `Toolbar` | Tabs + search + filters + right actions row (list pages) |
| `StatusChip` | `kind={ok|warn|danger|info|violet|accent|neutral}` |
| `StaffPills` | Filled/pending/open pill row + count |
| `AreaChart` | SVG area chart with rainbow option |
| `Sparkline` | Mini line chart |
| `QueueItem` | Action queue row (dashboard right column) |
| `StatRow` / `Stat` | Top-of-page metric ledger |
| `Card` | `.card` + `.card-head` + `.card-body` |
| `MetaGrid` | Key/value grid for drawer/detail hero |
| `SegmentedControl` | `.seg` tabs |
| `DefinitionList` | `.dl` grid |

Existing components that stay but get adapted to the new design:
- `BrandLogo` — replaced by sidebar brand mark.
- `FormBanner`, `FieldError`, `SignaturePad`, `RichTextEditor`, `FileUpload`, `LocationInput`, `TimePicker`, `SyrupPicker`, `PricingBreakdown`, `ConfirmModal`, `Toast`, `SessionExpiryHandler`, `ErrorBoundary` — stay as-is; cosmetic restyles only where they're used inside admin detail pages.

## CSS migration

- Port the design's `admin-os/styles.css` (1860 lines) into a new `client/src/index.css` section titled **"Admin OS"**, replacing all current `.admin-*` rules.
- Inherit the existing CSS custom-property pattern; no preprocessors.
- Keep `scroll-thin`, `skip-nav`, focus-ring, and all app-wide utility classes.
- Delete obsolete admin rules: `.admin-page`, `.admin-shell`, `.admin-sidebar`, `.admin-nav-item`, `.admin-content`, `.admin-breadcrumbs`, `.admin-table`, `.admin-sidebar-toggle`, `.admin-sidebar-overlay`, `.site-header` (the admin one), etc.
- Load fonts via `client/public/index.html`: Inter + JetBrains Mono only (lock the font pairing per Q4).

## Backend changes

None required for the UI revamp itself. Follow-ups (separate specs):
- `GET /api/admin/search?q=…` for the palette Records group.
- If new badge counts are needed (e.g., "unread conversations"), extend `/api/admin/badge-counts`.

## Testing plan

- Type check + build must pass at every commit.
- Each admin page renders for an authenticated admin without crashing.
- `ProtectedRoute adminOnly` guards preserved everywhere.
- Drawer state roundtrips cleanly through URL (opening a drawer → back button closes it → forward reopens it).
- User preferences persist across reload and logout/login (per-user key).
- Every existing admin feature keeps working — create proposal, send email, sign contract, record payment, review application, post blog article, edit drink plan, etc.
- Manual QA pass per phase: click every nav item, click rows to open drawers, click "Open page" to verify detail route loads, toggle skin and verify all surfaces restyle, toggle rail and verify layout doesn't break.

## Rollout (phased — trunk-based)

Each phase is a coherent merge-to-main; admin stays usable after every phase.

1. **Design system infrastructure** — port CSS, add `UserPrefsContext`, mount new Sidebar + Header + CommandPalette skeleton. Keep existing pages mounted unchanged (they inherit new shell but use their current body CSS, which mostly still compiles). Verify shell works end-to-end.
2. **Dashboard + Events flow** — rewrite `Dashboard`, `EventsDashboard`, `EventDetailPage`, build `EventDrawer` + `ShiftDrawer`. Delete `.admin-table` usage in these pages.
3. **Proposals flow** — rewrite list + detail + create, build `ProposalDrawer`.
4. **Clients flow** — rewrite list + detail, build `ClientDrawer`.
5. **Staff / Hiring / Financials** — rewrite these three together; they share the pipeline/card patterns.
6. **Drink Plans + Drink Library** — rewrite list/detail and build `DrinkPlanDrawer`.
7. **Email Marketing subsystem** — rewrite all 8 pages + build `LeadDrawer`.
8. **Blog + Settings (freestyle)** — new layouts in the same vocab.
9. **Cleanup** — delete dead `.admin-*` CSS, delete unused components (`AdminBreadcrumbs`, old `BrandLogo` admin variant if gone), delete old shift-detail route if fully merged into Event Detail, doc updates (CLAUDE.md + README.md + ARCHITECTURE.md folder trees per mandatory doc rules).

## Open risks / mitigations

| Risk | Mitigation |
|---|---|
| CSS regressions in non-admin pages if `.admin-*` removal accidentally touches shared selectors | Grep every deleted selector across the codebase before removal (Phase 9). |
| Drawer breaks if URL sync interferes with existing query-param usage on list pages | Use a dedicated `?drawer=` prefix, never reuse an existing param; audit each list page's query-param surface before wiring. |
| Proposal Detail handles both `/proposals/:id` and `/events/:id` — splitting risks inconsistency | New `EventDetailPage` is a new component; `ProposalDetail` keeps handling proposal route only. Event route routes to the new page. |
| Heavy forms (ProposalCreate, EmailCampaignCreate) may not fit the drawer shell | These are page-only, not drawer-accessible. Create-new buttons always navigate. |
| Font swap could break existing PDF generators / email templates that assume system fonts | Fonts are admin-UI-only (client-side). Server-side PDF (`agreementPdf.js`) and email templates are untouched. |

## Non-goals

- No change to staff portal, public site, client portal, or the Potion Planning Lab public flow.
- No change to any backend route, DB schema, or payment/auth logic.
- No change to transactional email templates or PDF generation.
- No rewrite of forms that don't live on admin routes (wizard components stay; only their admin-side embedding changes visually).

---

## Implementation plan

Next step: invoke `superpowers:writing-plans` to produce the phase-by-phase implementation plan that maps this spec to concrete commits.
