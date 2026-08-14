# Marketing Restyle: Apply the Approved Design

**Date:** 2026-08-14

**Tech Stack:** React 18 (CRA), vanilla CSS in `client/src/index.css`. Client-only; zero server changes.

**Spec:** `docs/superpowers/specs/2026-08-11-marketing-campaigns-design.md` section 10 (Visual contract, added 2026-08-14). That section IS this plan's requirements list; this doc only adds execution facts.

**Design benchmark:** `docs/design-artifacts/2026-08-11-marketing-redesign.dc.html`, verified byte-identical to the design project's current file on 2026-08-14.

**Why this plan exists:** the marketing section shipped 2026-08-14 functionally complete but styled on the legacy stylesheet: `MarketingLayout.js` wraps everything in the old dashboard's `em-dashboard`/`em-tabs` shell, and all `mkt-*` rules were hand-written on the legacy `--cream`/`--amber` tokens. The approved design was never consumed (see CLAUDE.md "Design artifacts are contracts", added the same day). This lane applies it.

## Verified ground truth (2026-08-14, do not re-derive)

- **The Admin OS layer the artifact assumes is ALREADY in the app.** `index.css` carries both skins (`html[data-app="admin-os"][data-skin="dark"]` at ~10790-11100, `[data-skin="light"]` at ~11100+) and every DS component class the artifact uses: `page-header`/`page-title`/`page-subtitle`/`page-actions`, `seg`, `card`/`card-head`/`card-body`/`k`, `tbl`/`tbl-wrap`/`num`/`shrink`, `queue-item`/`queue-icon`/`queue-title`/`queue-sub`/`queue-meta`, `tag`, `input-group`, `hstack`/`spacer`/`muted`, `btn` variants, `drawer` (27 rules), `palette-item`, `section-title`, `stat-label`/`stat-value`/`stat-sub`. NO new token work, NO design-system pulls needed.
- **`AdminLayout` toggles `data-app="admin-os"` on `<html>`; `UserPrefsContext` applies skin + accent HSL vars.** The reference implementation for a migrated page is `HiringDashboard.js:148`: `<div className="page" data-app="admin-os">` with `page-header`/`page-title`/`page-subtitle`/`page-actions`. Copy that pattern exactly.
- **The shell's live subtitle and budget meter feed from `GET /marketing/overview`**, which `OverviewTab.js:118` already calls. Lift one fetch into `MarketingLayout`, share via Outlet context; on error degrade to the bare title. No new endpoints.
- **Component inventory (all modest, largest 359 lines):** MarketingLayout 48, OverviewTab 253, AudiencesTab 205, ComposeTab 359, RecipientPicker 196, ContactDrawer 143, TagCell 137, DoNotContactControl 118, ContactTable 118, SentTab 103, HeldBackPanel 55, marketingFormat 103.
- **`Marketing - Today.dc.html` in the design project is a recreation of the OLD surface.** Never build from it.
- **The artifact's Look-panel data (4 themes, 6 accents, 5 fonts, `--em-*` vars) is in the artifact's trailing script block.** The shipped Look panel already implements the same options functionally; this is a re-skin of its controls plus the canvas frame, not a data change.

## Execution notes

- Behavior-inert is the law: same routes, same requests, same handlers, same guard rails, same copy semantics. The only wiring change is the lifted overview fetch in the layout.
- Replace the `em-dashboard` shell in `MarketingLayout` with the `page` pattern; keep the 4-tab IA (spec wins over the artifact's 5 tabs; Contacts stays inside Audiences).
- Compose folds to the artifact's 2 steps: the shipped Send step's content (count, budget breakdown, held-back list, test send, send button, no-scheduling line) becomes the "Before you send" rail on Recipients. Endpoints and the send confirmation content are untouched.
- Delete every legacy-token `mkt-*` rule that the restyle orphans; restyle survivors onto DS tokens. `index.css` gets a single new `/* Marketing (Admin OS) */` block for the marketing-specific pieces (moment hue spine, budget meter, email canvas `--em-*`, Look controls).
- Both skins must pass. New CSS uses DS tokens only, so House Lights mostly comes free; verify anyway.
- Tag hue map from the artifact: Corporate violet, Wedding info, Birthday warn, Do not contact danger, Thumbtack accent, Paid client ok, Quoted only neutral.
- No files added or removed, so no README/ARCHITECTURE tree changes.
- Verification in-lane: `CI=true npm run build` in `client/` once at the end (the Vercel CI gate), plus a Playwright browser pass on both skins against the running dev server.

---
lanes:
  - id: mkt-restyle
    phase: 1
    scope: >
      Rebuild the /marketing surface's markup and CSS to the design artifact
      per spec section 10: the page shell (header, subtitle, seg tabs, budget
      meter), Overview, Audiences, Compose (2-step with Look panel and email
      canvas), Sent, and the contact drawer, all on the existing Admin OS
      layer, both skins, behavior-inert.
    footprint:
      - client/src/pages/admin/MarketingLayout.js
      - client/src/pages/admin/marketing/**
      - client/src/index.css
    depends_on: []
    review_fleet: [code-review, ui-ux-review]
---
