# Marketing Restyle: Apply the Approved Design

**Date:** 2026-08-14. **Revised same day** after the full design-stage fleet (spec-grounding, spec-gaps, spec-risk, plan-fidelity, plan-decomposition, plan-feasibility) returned 17 blockers across spec section 10 and this plan. Every finding is folded into spec section 10 (the requirements list) and this revision; the fleet transcripts live in the session, the resolutions live in the docs.

**Tech Stack:** React 18 (CRA), vanilla CSS in `client/src/index.css`. Client-only; zero server changes.

**Spec:** `docs/superpowers/specs/2026-08-11-marketing-campaigns-design.md` section 10 (Visual contract). That section IS the requirements list, including the "shipped machinery survives" rule and the checkable definition of done. This doc adds only execution facts and order.

**Design benchmark and working input:** the artifact `docs/design-artifacts/2026-08-11-marketing-redesign.dc.html` PLUS the design system's own CSS pulled via DesignSync 2026-08-14 and vendored at `docs/design-artifacts/_ds/dr-bartender-os-design-system-72035042-c993-47e2-9dc8-c452b7bf5fa4/` (styles, components-admin, tokens; components-staff is a stub). The artifact now renders locally and the DS CSS is the authoritative reference for chip hues, drawer mechanics, seg, queue, and both skins' values.

## Verified ground truth (2026-08-14, fleet-checked; do not re-derive)

- The Admin OS layer exists in `index.css` under `html[data-app="admin-os"]` with both skins; every DS class the artifact uses is present. `/marketing` renders inside `AdminLayout` (`App.js:574` shell, `:622` route, `adminStrict`), which sets `data-app` on `<html>`; `UserPrefsContext` applies `data-skin` and the accent HSL vars. Reference page pattern: `HiringDashboard.js:148`.
- **Hue mechanics (fleet correction):** the app defines semantic hue vars ONCE on `html[data-app="admin-os"]`; the House Lights blocks do NOT flip them and instead recolor per component using `--ms-*` literals. Every new hue-bearing rule needs an explicit light companion. Tag hues ride the DS `.chip` kinds (`chip.violet/.info/.warn/.danger/.accent/.ok/.neutral`, `index.css` ~12780-12812), which already carry light overrides. `.tag` is one flat neutral rule; it gets no hue variants.
- **Drawer (fleet correction):** the DS drawer is state-class-driven: `.drawer` sits at `translateX(100%)` until `.open`, scrolls in `.drawer-body`, pairs with `.drawer-scrim.open`. A class swap without the `.open` toggle yields an invisible drawer. Use the classes, not `adminos/Drawer.js` (no focus handling, no aria-label); keep the shipped Escape/backdrop/ARIA.
- **CSS deletion facts:** all `mkt-*` rules live at `index.css:19828-19941` and are consumed only by `client/src/pages/admin/marketing/*`, EXCEPT `.em-retired-send` (`:19911`) which belongs to the legacy `EmailCampaignDetail.js` and SURVIVES. `mkt-drawer*`/`mkt-preview-frame` are used by BOTH ContactDrawer and ComposeTab's preview modal. The `em-*` family (including the `em-dashboard` remap blocks at `:11025-11048`) is shared with the live `/email-marketing` surface and is untouched. The dark-skin foreground remap that currently keeps `mkt-*` legible is the ROOT block at `:10832`; removing the `em-dashboard` wrapper changes nothing by itself.
- The shipped ComposeTab is a plain form (subject input, HTML textarea, RecipientPicker, two-stage confirm, resume banner, send-result panel, preview modal). No block palette, no Look panel, no test-send route, no Desktop/Mobile toggles. See spec section 10's Known functional gap; all of it is deferred (below).
- `GET /marketing/overview` (`marketingOverview.js`, response ~`:146-159`) already returns `today`, `open_moment_count`, and `send_budget {cap, used, remaining}`. `OverviewTab.js:118` calls it and MUTATES the payload locally on moment edit/dismiss, so the lifted fetch must expose an update path or the shell goes stale.
- Icons: `users`, `alert`, `mail`, `search` all exist in `components/adminos/Icon.js`. Component sizes are modest (largest ComposeTab, 359 lines; index.css is exempt from the size ratchet).
- Lane worktrees symlink `node_modules`, `client/node_modules`, `.env`, `client/.env`, so `CI=true npm run build` runs in-lane. The managed dev server holds :3000/:5000 serving MAIN, so no in-lane browser pass exists; browser verification is post-merge (below).

## Build order (lane `mkt-restyle`, checkpoint commit after each step)

1. **CSS foundation.** The new `/* Marketing (Admin OS) */` block in `index.css`, all rules scoped `html[data-app="admin-os"]`, each hue-bearing rule with a `[data-skin="light"]` companion: moment-card spine and layout, budget meter, reachable-base bars, dashed derived-chip variant, restyled `mkt-state`/`mkt-state-error`/`spinner`, `.seg a` companions to `.seg button`, pager and toolbar bits. Nothing consumes it yet; both skins' values cross-checked against the vendored DS CSS.
2. **Shell.** `MarketingLayout.js` onto the `page` pattern: `page-header` + subtitle + `page-actions`, seg NavLink tabs, budget meter, and the single overview fetch shared via Outlet context (`{data, error, refresh, update}`), per spec section 10's fetch-ownership bullet.
3. **Overview.** `OverviewTab.js` consumes the context (own fetch dropped, edit/dismiss write through `update`); moment cards, stat row, Needs-you/Reachable-base/Runs-without-you rail per the contract, every shipped control surviving.
4. **Audiences.** `AudiencesTab.js` rail + selected-audience card (incl. the Everyone variant), toolbar seg + search, `ContactTable.js` onto `tbl` (six shipped columns + pager), `HeldBackPanel.js` into the card region, `TagCell.js` onto `chip` kinds, `DoNotContactControl.js` restyled prompts.
5. **Drawer + preview modal.** `ContactDrawer.js` onto the DS drawer classes with the `.open` toggle; ComposeTab's preview modal onto the same treatment; ARIA and Escape/backdrop preserved.
6. **Compose.** Step seg with live count in the Recipients label, resume banner, Design-step interim column, Recipients grid with the full shipped picker, "Before you send" rail (single-source budget bar from context + selection, two-stage confirm, send-result panel).
7. **Sent.** `SentTab.js` onto `tbl` (shipped columns), automations queue card.
8. **CSS retirement.** Delete orphaned `mkt-*` rules only: re-grep every class for consumers first; `.em-retired-send` and all `em-*` stay.
9. **Verify in-lane.** `CI=true npm run build` in `client/` (exit 0); the definition-of-done logic-diff check over ComposeTab/RecipientPicker/TagCell/DoNotContactControl/ContactTable.

## Verification and review

- In-lane: the step-9 build + logic diff. Per-lane review fleet before merge: `code-review` (charged with behavior-inertness against the DoD) and `consistency-check` (cross-surface: shared CSS deletions, both skins, chip map identical across TagCell/ContactTable/ContactDrawer/RecipientPicker).
- Post-merge, pre-push: the managed dev server (serving merged main) hosts the browser pass, then `ui-ux-review` runs with the artifact + vendored DS CSS as its benchmark (its design-artifact adherence check). Both skins, all four tabs, drawer, send confirm, 1280/900/375. Findings are fixed before any push. This ordering exists because the lane cannot bind :3000/:5000.

---
lanes:
  - id: mkt-restyle
    phase: 1
    scope: >
      Rebuild the /marketing surface's markup and CSS to the design artifact
      per spec section 10: shell (header, live subtitle, seg tabs, budget
      meter, lifted overview fetch), Overview, Audiences, the two-step Compose
      FRAME around the existing plain composer (no Look panel, no palette, no
      test-send: deferred), Sent, contact drawer and preview modal on the DS
      drawer classes, tag chips on DS chip kinds. All on the existing Admin OS
      layer, explicit light-skin companions for every new hue rule, shipped
      machinery survives, behavior-inert per the spec 10 definition of done.
    footprint:
      - client/src/pages/admin/MarketingLayout.js
      - client/src/pages/admin/marketing/**
      - client/src/index.css
    depends_on: []
    review_fleet: [code-review, consistency-check, ui-ux-review]
---

## Deferred: `mkt-compose-canvas` (NOT in the lane map, on purpose)

Deliberately kept OUT of the machine-readable `lanes:` block so nothing schedules it: the fleet flagged that a YAML comment is invisible to the lane runner, the footprint-drift check, and auto-pull. It becomes a lane only when Dallas explicitly says go, at which point it gets added to a plan's front-matter.

Scope when greenlit: deliver spec 5.1's composer into the new Compose. Wire the existing `emailBuilder` block palette into the Design step; build the Look panel (four theme presets, font pickers, accent list, corner style) with the artifact's `--em-*` canvas token block and `swatch`/`em-select` controls (scoped, named to avoid the legacy `em-*` grep-space); add a test-send route for "Send test to me" and the Desktop/Mobile preview toggles. Touches how a draft's `html_body` is authored; the send path, guards, and resume machinery stay untouched.

Footprint when greenlit: `client/src/pages/admin/marketing/**`, `client/src/components/emailBuilder/**`, **plus its live consumers `client/src/pages/admin/EmailCampaignCreate.js` and `EmailCampaignDetail.js`** (any prop or signature change on the builder components reaches them), `client/src/index.css`, `server/routes/marketingSend.js` or a sibling for the test-send route, README/ARCHITECTURE for the route. Review fleet: code-review, consistency-check, security-review (new route), ui-ux-review.
