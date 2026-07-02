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

Root cause (audited, line-cited): components built pre-theming consume a set of FIXED light-paper "apothecary" tokens defined once on `:root` (`client/src/index.css:32-50`): `--cream`, `--parchment`, `--parchment-dark`, `--paper`, `--card-bg`, `--cream-text`, `--deep-brown`, `--warm-brown`, `--text-muted`. These never flip under `html[data-app="admin-os"][data-skin="dark"]` (After Hours), producing dark-on-dark text and stray light boxes. Prior sessions fixed this **per module** (`.em-dashboard` token re-scope + literal restores at `index.css:~10512-10534`, then `.form-label`, `.form-group small`, `.card`, `.card h1-h6`, `.sms-reply textarea`, `.doc-preview-*`), which is whack-a-mole: each fix covers one noticed symptom. This spec generalizes the proven `.em-*` pattern to the whole dark admin root so every consumer, noticed or not, flips at once.

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

### 2. Light-island restores (the risk, handled the em way)
THE inversion hazard: any admin-reachable rule that pairs a LIGHT surface token background with a remapped-token text color becomes light-on-light after the remap. The `.em-*` inner panels already carry literal restores (verified literal hex, not var(), so they survive the root remap untouched). At build, enumerate every admin-reachable rule with `background: var(--paper|--card-bg|--parchment|--parchment-dark|--cream)` and, for each, restore literal dark text under the dark scope (pattern: the em block at `:10517-10534`). Known candidates from the audit: `.sig-*` signature frames (parchment bg + `--deep-brown` labels on admin ProposalDetail), paper-background form inputs outside the already-fixed admin overrides (blog editor / settings), `.tip-*` paper cards on the admin user-detail tip tab, any `.data-table` parchment cells. The both-skin screenshot sweep is the completeness check for this list.

### 3. `--warm-brown` non-text usages (audit-flagged ambiguity)
`--warm-brown` doubles as a CTA-hover/border accent (`:50` comment). Before merging, grep its admin-reachable `background:`/`border:` usages; any such site needs a considered value (keep, or map to an accent token) rather than inheriting the ink-3 text mapping. Text usages (e.g. `.staffing-stat strong`) take the remap as-is.

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
- Both-skin screenshot sweep (dev server already running; Playwright when the shared browser frees, else Dallas's eyeball): EventDetailPage, ProposalDetail (incl. activity popup + signature frame), DrinkPlanDetail, ProposalCreate (syrup picker), a data-table dashboard (ChangeRequests), user-detail tip tab, blog editor/settings forms. Each in House Lights (must be pixel-unchanged) and After Hours (symptoms gone, no light-on-light islands).
- MenuPNG export generated while IN After Hours: output identical to House Lights export (immunity check).
- The four symptom checks above, explicitly.

## Risk
Medium-low and front-loaded: the remap itself is three declarations; the risk lives in island enumeration (light-on-light inversions), which the screenshot sweep exists to catch, and in `--warm-brown` non-text sites (audited before merge). Worst undetected failure mode is cosmetic (an unreadable admin panel in one skin), never client-facing: the one client-facing artifact rendered under the admin shell (MenuPNG) is verified token-free.

## Plan (single lane)
1. Cut lane `after-hours-token-remap` (footprint: `client/src/index.css` only).
2. Add the root remap + `!important` override; grep-audit `--warm-brown` bg/border sites; enumerate + restore light islands.
3. CI build; both-skin screenshot sweep; MenuPNG immunity check.
4. Focused review (CSS-only, nothing sensitive) with the screenshots as evidence.
5. Squash-merge; cleanup on approval.
