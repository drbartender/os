---
lanes:
  - id: after-hours-token-remap
    footprint:
      - client/src/index.css
    dependencies: []
    fleet: focused reviewer + both-skin screenshot evidence (CSS-only, no sensitive paths; blast radius is the review subject)
---

# After Hours Token Remap — Design (2026-07-02)

## Context
Fix-list item: "After Hours Theme CSS errors" (Client Name at the top, date under staffing, invoices under payment, basically the whole drink plan). Dallas clarified mid-brainstorm: **"There are little issues all over. The ones on my list were just the ones I happened to notice."** The list is a sample, not a spec.

Root cause (audited, line-cited): components built pre-theming consume a set of FIXED light-paper "apothecary" tokens defined once on `:root` (`client/src/index.css:32-50`): `--cream`, `--parchment`, `--parchment-dark`, `--paper`, `--card-bg`, `--cream-text`, `--deep-brown`, `--warm-brown`, `--text-muted`. These never flip under `html[data-app="admin-os"][data-skin="dark"]` (After Hours), producing dark-on-dark text and stray light boxes. Prior sessions fixed this **per module**, which is whack-a-mole: each fix covers one noticed symptom. The dark-scoped precedents are `.em-dashboard` (token re-scope + literal restores, `index.css:~10512-10534`), `.form-label` (`:10543`), `.form-group small` (`:10549`), `.card` / `.card h1-h6` (`:10560`/`:10571`); two other prior fixes (`.sms-reply textarea` at `:13831`, `.doc-preview-*` at `:8544+`) are both-skin `html[data-app="admin-os"]` rules built token-adaptive from the start, cited here as the FORM-CONTROL precedent, not as dark restores. This spec generalizes the proven `.em-*` pattern to the whole dark admin root so every consumer, noticed or not, flips at once. (Mechanism note: `data-app` is set on `document.documentElement` by `AdminLayout.js:21`; `data-skin` by `UserPrefsContext.js:91` off the Sidebar's `setPref('skin', …)`. Skin defaults to `dark` and co-applies atomically with the dark surface tokens — the same selector — so there is no half-applied state; portals inherit because both attributes live on `<html>`.)

## Audit findings the design rests on (2026-07-02 agent audit, line-cited)
- **Blast radius is naturally contained.** The large majority of ~650 token usages are PUBLIC-ONLY families (`.wz-*` quote wizard, `.potion-*` planner, `.ws-*` website, `.cp-*` public portal, `.invoice-*` public invoice, `.lab-*` blog, Sign&Pay families). They never render under `html[data-app="admin-os"]`, so a dark-admin-scoped re-declaration cannot touch them, by construction. House Lights (`data-skin="light"`) is likewise untouched.
- **Admin-reachable consumers** (the fix targets): generic `.card` text inheritance, `.staffing-stat strong` (`:3284`, `--warm-brown` on dark), `.data-table`/`.admin-table`, `.em-*` (already fixed), `.syrup-*` (ProposalCreate), `.sig-*` (ProposalDetail signature frame), `.tip-*` (user-detail tip tab), `.client-*` (ChangeRequestCard), `.form-*`, `.checkbox-*`, plus base rules (`.card p`, `.card h1-h4` at `:159-163`).
- **The MenuPNG export is immune by construction, not by carve-out.** The html2canvas capture node (`MenuPNG.jsx:96-108` wrapping `MenuPreview variant="print"`) uses ZERO tokens: all colors are literals from the `PRINT` constant (`MenuPreview.js:12-21`, `bg:'#12161C'`, `cream:'#F0E8D6'`) applied inline, and html2canvas is forced `backgroundColor:'#12161C'` (`MenuPNG.jsx:42`). No token remap can darken the client-facing menu export. Verify at build; no carve-out rule needed.
- **`InvoiceDropdown` is already dark-themed** (`index.css:9102-9120`); `.meta-k`/`.dl`/`.num` already resolve to `--ink-*` under admin-os (`:12296-12323`).
- **The one straggler a token remap cannot reach:** `index.css:1601-1604` — `.admin-table .text-muted, .data-table .text-muted { color:#5C3319 !important; }`. The `!important` literal beats the existing dark `.text-muted` remap (`:10564`); admin dashboard muted table text renders dark-brown-on-dark today.

## Design

### 1. Foreground token remap on the dark admin root (the core)
One block in `index.css`, adjacent to the existing dark-skin token block (`~:10437`):
```css
html[data-app="admin-os"][data-skin="dark"] {
  --deep-brown: var(--ink-1);   /* primary text  (.em- precedent, :10513) */
  --warm-brown: var(--ink-3);   /* secondary/accent text (.em- precedent) */
  --text-muted: var(--ink-3);   /* muted text (matches :10551 fix) */
}
```
Deliberately NOT remapped:
- `--cream-text` (#F0E8D6): already a light foreground, correct on dark surfaces. Remapping would break light-on-dark text.
- Surface tokens (`--paper`, `--card-bg`, `--cream`, `--parchment`, `--parchment-dark`): light islands stay light. This matches the `.em-*` fix's structure, whose literal dark-text restores (`:10517-10534`) only hold because the surfaces stayed light. Flipping surfaces would be a much larger redesign with worse failure modes.

### 2. Light-island handling (the risk; fleet-corrected and pre-enumerated)
THE inversion hazard: an admin-reachable rule pairing a LIGHT surface-token background with a remapped-token text color becomes light-on-light after the remap. The fleet ran the enumeration grep (84 hits total) and corrected rev 1's instruction with the load-bearing DISCRIMINATOR:

**For each admin-reachable paper-bg rule, first check whether admin-os ALREADY repaints that background dark. Only stay-light surfaces get restores.** Blindly restoring dark text on already-darkened surfaces (`.card` base paper bg is overridden to `var(--bg-1)` at `:11965`; `.file-upload-area` to `var(--bg-2)` at `:998`) would produce dark-on-dark on the two biggest admin surfaces — for those, the remap's light text is already correct and NO island rule is written.

Stay-light islands, by treatment (fleet-enumerated; the sweep remains the completeness check):
- **Form controls — the highest-impact island, re-skin rather than restore.** The base `.form-input, .form-select, .form-textarea` rule (`:477-491`) is paper bg + `--deep-brown` text with NO admin override except `.sms-reply textarea`. Generalize that exact precedent: one both-skin `html[data-app="admin-os"]` rule re-skinning all three controls to the token-adaptive dark input treatment (`--bg-1` / `--line-2` / `--ink-1`, mirroring `:13831`), leaving the global rule untouched for public/auth/proposal forms. Covers blog editor, settings, and every bare admin form; the `.sms-reply` rule becomes redundant-but-harmless. Include `.radio-option` / `.checkbox-label` companions if they carry paper bg.
- **Dashboard tables — keep them light, restore text.** `.data-table` / `.admin-table` (`:1571` th parchment-dark, `:1586` td card-bg, `:1597` hover parchment, `:1641` dragging) read fine today as light tables in the dark UI. Minimal change: literal dark-text restores under the dark scope (em pattern), preserving today's look on AdminDashboard / ChangeRequestsDashboard / CocktailMenuDashboard.
- **Literal restores (em pattern) for the remaining stay-light islands:** `.sig-*` / `.signature-*` frames (`:1199,1213,1232,1264` — admin ProposalDetail), `.rte-wrapper` / `.rte-toolbar` / `.rte-btn:hover` (`:7927,7935,7952` — TipTap blog editor, missed by rev 1), `.admin-plan-logo-thumb` (`:13728`), `.tip-*` paper cards on the user-detail tip tab, and `.card-clickable:hover` (`:184` — parchment hover flash not covered by the base `.card` dark override; give it a dark hover value instead of a restore).

### 3. `--warm-brown` non-text usages (fleet-resolved: two admin sites, not moot)
The fleet ran the deferred grep: 7 bg/border hits, 5 public-only. The two ADMIN-reachable sites that must not inherit the ink-3 text mapping:
- **`.btn-primary:hover:not(:disabled)` (`:344`, `background: var(--warm-brown)`)** — by specificity this base hover beats the admin `.btn-primary` background (`:11861`; the admin hover at `:11867` sets only `filter`), so admin primary buttons genuinely flash warm-brown on hover today and would go muted-gray after the remap. Fix: a dark-scope override matching the admin `.btn-primary` base background treatment's hover-appropriate accent (read the admin button tokens at build; eyeball in the sweep).
- **`.equipment-badge` (`:3368`, border)** — admin EquipmentDisplay; map the border to the admin accent/line vocabulary at build rather than gray.
Text usages (e.g. `.staffing-stat strong` at `:3284`) take the ink-3 remap as-is; if the emphasis reads too flat in the sweep, bump that one selector to `--ink-2`.

### 4. The `!important` straggler
```css
html[data-app="admin-os"][data-skin="dark"] .admin-table .text-muted,
html[data-app="admin-os"][data-skin="dark"] .data-table .text-muted { color: var(--ink-3) !important; }
```
(Or delete `:1601-1604` if the light-skin sites tolerate the base `.text-muted`; the override is the safer, smaller change.)

### 5. Redundant-but-harmless prior fixes stay
The per-module patches (`.card`, `.card h1-h6`, `.form-label`, `.em-*`) become redundant where they overlap the root remap. Leave them: removing them widens the diff and risks regressions for zero benefit; they can be garbage-collected in a later CSS-hygiene pass.

## Symptom acceptance checks (Dallas's four, audit-mapped)
1. Client Name at the top — `.card h1` inheritance on EventDetailPage; covered by remap (partly patched already at `:10571-10578`).
2. Date under staffing — `.card`-inherited `<strong>` + `.staffing-stat strong` (`--warm-brown`); covered by remap.
3. Invoices under payment — ProposalDetailPaymentPanel generic `.card` text residue; covered (InvoiceDropdown already themed).
4. The whole drink plan — DrinkPlanCard/DrinkPlanSelections/DrinkPlanDetail use generic `.card`/`.muted`/`.text-muted`/`.dl` (no `.potion-*`/`.cp-*` on admin surfaces, verified); covered, PLUS the `:1604` fix for any table-context muted text.

## Non-goals
- No surface-token flip (paper stays paper; islands restored, not redesigned).
- No public-page changes of any kind (structurally impossible under the scope).
- No removal of prior per-module fixes.
- Staff portal (`--sp-*` skins) untouched — separate, healthy token system.

## Verification
- `CI=true react-scripts build` clean.
- Both-skin screenshot sweep (dev server already running; Playwright when the shared browser frees, else Dallas's eyeball): EventDetailPage, ProposalDetail (incl. activity popup + signature frame), DrinkPlanDetail **plus its two modals (ShoppingListModal and ConsultationForm)**, ProposalCreate (syrup picker + bare form fields), a data-table dashboard (ChangeRequests), user-detail tip tab, blog editor (the `.rte-*` toolbar + form fields), settings forms, and **button hover states** (the `.btn-primary` warm-brown hover fix). Each in House Lights (must be pixel-unchanged) and After Hours (symptoms gone, no light-on-light islands, no dark-on-dark from over-restoring).
- MenuPNG export generated while IN After Hours: output identical to House Lights export (immunity check).
- The four symptom checks above, explicitly.

## Risk
Medium-low and front-loaded: the remap itself is three declarations; the risk lives in island enumeration (light-on-light inversions), which the screenshot sweep exists to catch, and in `--warm-brown` non-text sites (audited before merge). Worst undetected failure mode is cosmetic (an unreadable admin panel in one skin), never client-facing: the one client-facing artifact rendered under the admin shell (MenuPNG) is verified token-free.

## Plan (single lane; build checklist — the fleet pre-ran the enumeration, so these are concrete steps, not investigations)
1. Cut lane `after-hours-token-remap` (footprint: `client/src/index.css` only).
2. Core: the 3-token dark-root remap block (§1) + the `!important` table override (§4).
3. Form controls: the both-skin `html[data-app="admin-os"]` re-skin of `.form-input/.form-select/.form-textarea` (+ paper-bg `.radio-option`/`.checkbox-label` companions), generalizing `:13831` (§2).
4. Dashboard tables: literal dark-text restores for `.data-table`/`.admin-table` th/td/hover/dragging under the dark scope (§2).
5. Literal restores: `.sig-*`/`.signature-*`, `.rte-*`, `.admin-plan-logo-thumb`, `.tip-*` paper cards; dark hover for `.card-clickable:hover` (§2). Apply the discriminator — skip any surface admin-os already darkens (`.card` `:11965`, `.file-upload-area` `:998`).
6. Accents: `.btn-primary:hover` background + `.equipment-badge` border dark-scope overrides (§3).
7. CI build; both-skin screenshot sweep per Verification (including the two DrinkPlanDetail modals and hover states); MenuPNG immunity check; the four symptom checks.
8. Focused review (CSS-only, nothing sensitive) with the screenshots as evidence.
9. Squash-merge; cleanup on approval.
