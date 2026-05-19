# Mobile + Desktop Responsiveness Remediation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the responsive/device defects found in `.claude/mobile-audit-2026-05-15/MERGED.md`, grouped into independently-revertable commits, sequenced by risk and dependency.

**Architecture:** Vanilla CSS (`client/src/index.css`, ~11.5k lines, `html{font-size:17px}` so the 16px floor = 0.95rem) + React 18 components. Two systemic root causes (admin sidebar non-responsive; default dark theme hardcodes light text) account for most raw findings — each is one isolated commit. The rest are independent.

**Tech Stack:** React 18 CRA, React Router 6, vanilla CSS `@media`, Playwright MCP for verification.

---

## Domain adaptation (read first)

This is responsive CSS remediation, not feature code. Adapting the skill's TDD loop honestly:

- **"Test" = a browser-measurable acceptance gate** at the audited viewports, run via Playwright MCP / dev browser — the *same* checks the audit used: `document.scrollingElement.scrollWidth > clientWidth` (overflow), `getComputedStyle` WCAG contrast ratio, `getBoundingClientRect` tap-size, input `font-size` ≥16px. Each task states its exact gate and the pass threshold.
- **Trivial items** (quick-wins) have exact file:line + the exact change — fully concrete.
- **Systemic items** (C1/C2) give exact target files + the transformation rule + a precise numeric acceptance gate, with an explicit *investigate-the-current-cascade* first step. Fabricating exact final CSS for an 11.5k-line cascade without reading it would be the real plan failure; the precise gate makes "done" unambiguous instead.
- **Prereq:** `npm run dev` running at `http://localhost:3000`; localhost dev tokens/creds from the audit session (proposal `ba359ad7…`, plan/shopping `28390704…`, invoice `56a1fed6…`, admin `admin@drbartender.com`/`DrBartender2024!`). Live `pk_live_` Stripe key is active in dev — never submit a payment while verifying.
- **No regression rule:** every systemic batch must verify the **≥768/≥1024 desktop layout is unchanged** in addition to the mobile fix.
- Fixing is decoupled from auditing (per the audit design). Each batch = one logical commit per CLAUDE.md Rule 3. Commit only on the user's cue; never push without an explicit push cue.

---

## Execution status — updated 2026-05-19 (read before resuming)

**Shipped (committed local on `main`, NOT pushed):**

| Commit | Batch | Verification |
|---|---|---|
| `695ceb6` | Batch 0 — quick wins | eslint clean; user spot-check |
| `ac6c740` | Batch 1 — `100vh`→`100dvh` | eslint clean |
| `ee72f56` | Batch 2 / **C3** — adminos inputs ≥16px on touch | cascade-reasoned; device-emulation spot-check |
| `3ced753` | **C2a** email-marketing | Playwright WCAG: 0 fails all 4 sub-tabs, dark + House Lights |
| `9b6c891` | **C2b** blog editor / `.form-label` | Playwright: 0/138 dark; no light regression |
| `cd76bbb` | **C2c** drink-plan detail (systemic `.card`/heading/`.muted` dark re-tints) | Playwright: 0/25 dark; no light regression |
| (no code) | **C2d** event detail | fixed for free by C2c; Playwright-verified H1 no longer invisible |

Note: C2a–C2c live in `client/src/index.css` in the **"After Hours overrides"** section (search `[data-skin="dark"] .em-`, `.form-label`, `.card p`). C2b also touched `BlogDashboard.js`; C2c also touched `DrinkPlanDetail.js` (removed inline `color: var(--text-muted)`).

**Done:** C3 (fully). C2 = 4 of 5 surfaces (a–d).

**Remaining / not started:**
- **C2e — settings** (DEFERRED). `SettingsDashboard.js` has dozens of inline `color: var(--deep-brown/--warm-brown/--text-muted)` across sub-components, no clean root wrapper. Recommended fix: add a root className to SettingsDashboard's component root, then a C2a-style dark-skin token-scope block on it (`{ --deep-brown: var(--ink-1); --warm-brown: var(--ink-3); --text-muted: var(--ink-3); }`). Verify all 3 tabs + House Lights.
- **Batch 4 — C1 admin sidebar** (NOT started — single highest-impact item; whole adminos app ≈140px on phones across ~15 routes).
- **Batch 5 — tablet-band 768–1024 collapse** (H8–H11) — not started.
- **Batch 6 — standalone Highs** (H3 `.icon-btn`, H4 cocktail drag touch-fallback, H5 quote stepper overflow, H6 spinners, H7 plan review-card overflow) — not started.
- **Batch 7 — post-C1 residual mobile** — blocked on Batch 4.
- **Batch 8 — Medium/Low cleanup** — not started.
- **Staff portal** — parked/blocked (needs valid local staff creds + `staff.localhost` host-spoof, or manual on real subdomain).

**Out-of-scope findings discovered during C2 (NOT the C2 invisibility bug — separate, logged, not fixed):**
1. **House Lights** `.muted`/section-title/`TH` ≈ **4.22:1** and `.btn-ghost` danger ("Delete") ≈ **2.56:1** — app-wide, pre-existing, marginally sub-AA. House Lights `.muted` uses light `--ink-3` (#7A7468) on paper. Future polish: bump House Lights muted token to ≥4.5.
2. **adminos dark** `.k`/`.meta-k` labels ≈ **2.78:1** (event detail etc.) — they use `--ink-4` (#565d69, the deliberately-faint "placeholder/disabled" token) for real labels. Future: switch those labels to `--ink-3`.
3. **`.btn-success "On"`** ≈ **1.19:1** on dark (settings toggles) — white on too-light green. Button-palette issue; needs an After Hours `.btn-success` bg override (mirror the existing `[data-skin="dark"] .btn-primary` pattern at ~`index.css:9591`).

**Verification method that worked (reuse it):** Playwright MCP, log in admin (`admin@drbartender.com` / `DrBartender2024!`) at localhost:3000, navigate the surface, run a WCAG contrast scan (computed `color` vs effective bg, fail < 4.5 / < 3 for ≥24px-or-bold). Toggle skins via the **real** `button.mode-opt` ("House Lights"/"After Hours") — forcing `data-skin` via `setAttribute` desyncs from React and gives false positives. All C2 fix CSS is `[data-skin="dark"]`-scoped so House Lights is unaffected by construction; still verify via the real toggle.

**Repo state:** nothing pushed (no push cue all session) — 6 remediation commits + earlier spec commit `9a9e18d` sit local on `main`. Untracked & intentionally uncommitted: `.claude/mobile-audit-2026-05-15/`, this plan doc, `docs/superpowers/specs/2026-05-17-potion-planner-redesign-design.md` (not authored here). Also modified by a parallel session (left untouched): `client/src/components/ShoppingList/shoppingListPars.js`, `server/utils/shoppingList.js`.

**Recommended resume point:** Batch 4 (C1 sidebar) — highest impact, unblocks Batch 7. C2e and the 3 findings above are low-severity and can wait.

---

## Surface inventory & redesign-tool scope (added 2026-05-19)

User decision on 2026-05-19: several admin surfaces are scheduled for a full design-tool pass and **must be left out of this remediation effort** — any fixes here would be overwritten by the redesign. Exception: **Event Detail** has already been run through the tool, so defects there are real bugs and stay in scope.

### LEAVE OUT — design tool will redo (do not work on these here)
- **`/email-marketing`** + all sub-tabs (Leads, Campaigns, Analytics, Conversations, Lead-detail, Campaign-create/detail)
- **`/settings`** (Drink Menu, Calendar Sync, Auto-Assign tabs)
- **Cocktail Menu** (`CocktailMenuDashboard`) — incl. H4 cocktail-reorder touch fallback
- **`/drink-plans`** list and **`/drink-plans/:id`** detail
- **`/blog`** dashboard + post editor

**Note — keep the C2 CSS rules I shipped (do NOT revert them):** the systemic `[data-skin="dark"]` overrides in the After Hours section of `index.css` (`.card` text re-tint, `.card p`, `h1–h6`, `.muted`/`.text-muted`, `.form-label`, `.form-group small`, `.blog-editor-upload-placeholder`, `.em-*` token-scope) are general adminos-dark hygiene that benefits the *kept* pages (event detail, dashboard, etc.). They become harmless dead CSS for the leave-out surfaces once the design tool replaces those — easy to remove post-redesign.

### IN SCOPE — already run through the design tool; fix defects here
- **`/events/:id` (Event Detail)** — remaining items:
  - **H10** — two-column layout doesn't collapse at 768 (Payment/right rail clipped on iPad portrait). Belongs to Batch 5.
  - Content min-width ~651px on mobile (Batch 7 residual, blocked on C1).
  - **Newly in scope (previously logged out-of-scope):** `.k`/`.meta-k` labels ~2.78:1 on dark — they consume `--ink-4` (the deliberately-faint "placeholder/disabled" token) for real labels; switch those rules to `--ink-3`.

### On the new tool, no special handling — kept; only C1/Batch-shell work applies
`/dashboard`, `/proposals` list, `/proposals/new` (ProposalCreate), `/events` list, `/clients`, `/financials`, **`/tips`** (gold reference).

### Likely intentional — client/public surfaces (confirm scope before any work)
`/proposal/:token`, `/invoice/:token`, `/shopping-list/:token`, `/plan/:token` (public), `/tip/:token`, marketing/website (`.ws-*`), `/quote` wizard, auth pages. These use the original chalkboard / `--deep-brown` / `--paper` system + `drb-tokens.css`. May be the *intended* design, not "tool not run yet." Includes audit items **H5/H6** (quote stepper/spinners), **H7** (plan review-card on money path), **H8** (invoice sticky panel). **User confirmation needed** on whether any of these should be addressed here vs. left as-is.

### Effect on remaining batches (post-decision)
- **Batch 4 — C1 admin sidebar:** **IN** (unchanged — affects all kept admin pages; highest-impact remaining item).
- **Batch 5 — tablet-band 768–1024 collapse:** PARTIAL — keep **H9** ProposalCreate + **H10** event detail; **skip H11** drink-plan `.page-actions` (leave-out); **H8** invoice = client-confirm.
- **Batch 6 — standalone Highs:** PARTIAL — keep **H3** `.icon-btn` ≥44px (adminos universal kebab/modal close — affects every kept admin page); **skip H4** cocktail reorder (leave-out); **H5/H6** quote wizard + **H7** plan review = client-confirm.
- **Batch 7 — post-C1 residual mobile:** PARTIAL — keep event-detail min-width, dashboard KPI grid, ProposalCreate residuals; **skip** drink-plans table + settings tables/tabs (leave-out). Still blocked on Batch 4.
- **Batch 8 — Medium/Low:** triage per surface against the lists above. Drop most settings/drink-plans/cocktail/blog items; keep admin-shared (e.g., `ClickableRow` touch handler) + event-detail items + auth-form items.
- **Out-of-scope findings previously logged:** only the **adminos-dark `--ink-4` labels** finding is now back in scope (because it affects event detail). The other two — House Lights ~4.22 app-wide and `.btn-success` 1.19 on dark — remain out-of-scope / future polish.

### Legacy `.admin-sidebar` shell (Tier 2, structural)
`index.css:1696–1808` is a *separate, older* admin layout from the new adminos `Sidebar.js`. Likely being phased out by the redesign; no active work here unless something kept still mounts under it. Verify if any kept route still uses it before any work.

---

## Batch sequence & dependencies

| Batch | Title | Risk | Depends on |
|---|---|---|---|
| 0 | Quick wins (6 isolated fixes) | minimal | — |
| 1 | `100vh` → `100dvh` shells | low (mechanical) | — |
| 2 | C3 — iOS focus-zoom (adminos inputs <16px) | medium (whole admin app, CSS) | — |
| 3 | C2 — dark-theme contrast (systemic) | medium-high (theme system) | — |
| 4 | C1 — admin sidebar responsive (systemic) | **high** (admin shell) | — |
| 5 | Tablet-band (768–1024) two-column collapse | medium | — |
| 6 | Standalone Highs (H3/H4/H5+H6/H7/H12) | mixed | — |
| 7 | Post-C1 residual mobile passes | medium | **Batch 4 merged + re-audited** |
| 8 | Medium / Low cleanup | low | Batch 4 (some items) |
| — | Staff portal | BLOCKED — decision, not a batch | see Parked |

Batches 0–6 are mutually independent and may be done in any order / parallel terminals. **Only hard dependency: Batch 7 must follow Batch 4.** Recommended order = the table order (front-load zero-risk momentum, then systemic, then dependent residual).

---

## Batch 0 — Quick wins (one commit)

**Files / changes (each is exact, from the audit):**
- `client/src/index.css:3910-3917` — `.ws-form-field input, select, textarea`: `font-size: 0.92rem` → `font-size: 1rem` (=17px ≥16; kills iOS zoom on the public quote wizard). [H1]
- `client/src/pages/Login.js` (email/password inputs), `client/src/pages/Register.js` (email/password/confirm), `client/src/pages/ResetPassword.js` (password fields), `client/src/pages/PreHireOnboarding.js` (email/password), `client/src/pages/public/ClientLogin.js` (email input): add `autoComplete` — `"username"`/`"email"` on email, `"current-password"` on login password, `"new-password"` on register/reset/onboarding new-password fields. [S2/R6]
- `client/src/pages/Application.js:332` and `client/src/pages/ContractorProfile.js:207` — add `inputMode="numeric"` and `autoComplete="postal-code"` to the `zip_code` input. [S2]
- Drink-plans status filter chips — add a space/gap between label and count so it renders `All 18` not `All18` (find the chip render in the drink-plans dashboard component; add a `{' '}`/separate count `<span>` with margin). [R4a]
- Quote-wizard phone mask util — normalize to `(312) 555-0199` (space after `)` and around `-`). Locate the mask helper used by the wizard phone field; fix the format string. [R1]
- Quote-wizard resume banner — gate "Welcome back…" on a **non-empty** `localStorage.drb_quote_draft` (currently shows on a fresh load). Add the emptiness check to the banner's render condition. [R1]

- [ ] **Step 1 — apply all six changes** (exact anchors above).
- [ ] **Step 2 — verify (browser, dev server up):**
  - `/quote` @ 390: `getComputedStyle($('.ws-form-field input')).fontSize` ≥ 16px.
  - `/login`,`/register` @ any: each email/password input has the expected `autocomplete` attribute (DOM check).
  - `/apply` @ 390: focus zip → numeric keypad (attribute present).
  - drink-plans list: chip reads `All 18`.
  - `/quote` Step II: type `3125550199` → renders `(312) 555-0199`.
  - `/quote`: `localStorage.removeItem('drb_quote_draft')`, reload → banner absent; set a draft → banner present.
- [ ] **Step 3 — commit** (on user cue): `git add` the six files; `git commit -m "fix(responsive): quick-win batch — ws-form input zoom, auth autocomplete, zip inputmode, chip spacing, phone mask, resume-banner gating"`

---

## Batch 1 — `100vh` → `100dvh` (one commit) [H2]

**Files (from `[S1]`):** inline styles in `client/src/pages/Login.js:64`, `Register.js:66`, `ForgotPassword.js:34`, `ResetPassword.js:77`, `ApplicationStatus.js:20`, `Application.js:223`, `HiringLanding.js:7`, `PreHireOnboarding.js:117`, `components/StaffLayout.js:37`, `pages/proposal/proposalView/styles.js:14`, `pages/public/ClientShoppingList.js:235`; CSS `client/src/index.css:104,123,1693,1703,1798,3328,6053,8367,10379`.

- [ ] **Step 1** — replace `100vh` / `min-height:100vh` with `100dvh`, keeping a `100vh` fallback line immediately before (`min-height:100vh; min-height:100dvh;`). For `calc(100vh - …)` use `calc(100dvh - …)` with the same fallback pattern. Eyeball each — do not blind find/replace; confirm each is a viewport-height shell, not an intentional `vh` use.
- [ ] **Step 2 — verify:** at 390×844 emulated, `/login`, a proposal link, `/shopping-list/28390704-…`: the primary CTA/footer is within the initial viewport (not pushed under a simulated browser chrome). Desktop ≥1024 visually unchanged.
- [ ] **Step 3 — commit:** `git commit -m "fix(responsive): use 100dvh on auth/proposal/shopping shells to stop iOS Safari toolbar clipping the CTA"`

---

## Batch 2 — C3 iOS focus-zoom: adminos inputs <16px (one commit) [C3]

**Files:** `client/src/index.css` — `:9789` `.header-search` (12px), `:9872-9877` `[data-skin="light"] .input/.select` (12.5px), `:10876-10882` `html[data-app="admin-os"] .input,.select` (12.5px), `:10914-10918` `.input-group input` (12.5px). Reference: `:10238`,`:11363` already correctly use 16px.

- [ ] **Step 1 — read** the four rule blocks + the desktop-density expectation around them to choose the guard. Decision rule: raise these to **≥16px on coarse pointers** via `@media (pointer: coarse) { … font-size:16px }` (or `font-size: max(16px, <current>)`), preserving the dense look on `pointer:fine` desktop.
- [ ] **Step 2 — apply** the coarse-pointer ≥16px rule for all four selectors.
- [ ] **Step 3 — verify:** logged into admin, at 390 emulated with a coarse-pointer context, `getComputedStyle` of `.header-search`, an adminos `.input`, a `.select`, an `.input-group input` each reports `font-size` ≥ 16px; on a `pointer:fine` 1440 desktop the same elements keep their compact size (visual unchanged).
- [ ] **Step 4 — commit:** `git commit -m "fix(responsive): adminos inputs/select/header-search >=16px on touch to stop iOS focus-zoom"`

---

## Batch 3 — C2 dark-theme contrast, systemic (one commit) [C2] — HIGH PRIORITY, high care

Default "After Hours" theme paints hardcoded light-theme near-black text (`≈rgb(28,22,16)`/`#1c1610`) on the dark bg → 1.03–1.5:1, whole modules invisible **incl. desktop**. `/tips` is correctly themed — it is the reference for correct token usage.

**Suspected surfaces:** `/email-marketing` + all 4 sub-tabs, `/blog` post editor labels, `/drink-plans/:id` body, `/events/:id` H1, `/settings` Auto-Assign helper + Drink-Menu section headings. Components live under `client/src/pages/admin/` (EmailMarketing*, BlogDashboard, DrinkPlanDetail, EventDetailPage, SettingsDashboard) and possibly shared CSS in `index.css`.

- [ ] **Step 1 — investigate:** grep the suspected components + `index.css` for hardcoded dark text colors (`#1c1610`, `rgb(28,22,16)`, literal near-black `color:` on text/labels/headings) and for `.house-lights`-scoped text rules with no After Hours counterpart. Identify the After Hours foreground token `/tips` uses (compare `/tips` computed `color` to the token defs near `index.css:44` — `--text-muted` etc.).
- [ ] **Step 2 — transform:** replace each hardcoded text/label/heading color on the affected surfaces with the theme foreground token (`var(--text…)` / the token `/tips` uses) so it follows the active skin. Do not invent new tokens; reuse the working ones.
- [ ] **Step 3 — verify (the gate is numeric):** default After Hours theme, at **1440** (no sidebar factor): on `/email-marketing` (+ each sub-tab), `/blog` editor, `/drink-plans/:id`, `/events/:id`, `/settings`→Auto-Assign — every previously-failing text node computes a WCAG contrast ≥ **4.5:1** (≥3:1 for ≥24px/bold). Then toggle **House Lights** and re-check the same nodes are still ≥4.5:1 (no regression of the light theme). Spot-check 390 too.
- [ ] **Step 4 — commit:** `git commit -m "fix(theme): bind admin content/label/heading colors to theme tokens so After Hours (default dark) is readable"`

---

## Batch 4 — C1 admin sidebar responsive, systemic (one commit) [C1] — HIGHEST blast radius

The **adminos** shell — `client/src/components/adminos/Sidebar.js` + `Header.js` (+ adminos CSS, `html[data-app="admin-os"]` scoped). NOT the legacy `.admin-sidebar` (`index.css:1696-1808`, already has a 768px off-canvas). Sidebar is fixed 220px `position:static`, no breakpoint, no hamburger → `<main>` 132–194px on phones; existing "collapse to rail" defaults expanded and is stranded below the fold.

- [ ] **Step 1 — read** `adminos/Sidebar.js`, `adminos/Header.js`, the adminos shell layout (where `<aside>`+`<main>` are composed — likely `AdminLayout.js` or an adminos layout), and the adminos sidebar/rail CSS. Identify the existing rail-collapse state + its `localStorage` key (`drb-admin-prefs-1`).
- [ ] **Step 2 — implement** a `≤900px` responsive mode: sidebar becomes an off-canvas drawer (translateX off-screen by default, slide in over an overlay) toggled by a **hamburger added to the adminos Header**, with body scroll-lock while open and Esc/overlay-click to close; `<main>` takes the full viewport width below 900px. (Reusing/auto-applying the existing 54px rail below 900px is an acceptable simpler alternative if the drawer proves heavy — but the drawer is the better UX; pick one, keep it one commit.)
- [ ] **Step 3 — verify:** logged into admin, at 360/390/414: `document.querySelector('main')` clientWidth ≈ full viewport (NOT 140–194px); a hamburger is visible and opens the nav; overlay + scroll-lock work; Esc/overlay closes; nav links reachable. At 1024/1440: sidebar unchanged from today (no regression). Re-check `/proposals/new` is now usable (the worst-hit route).
- [ ] **Step 4 — commit:** `git commit -m "feat(adminos): responsive off-canvas sidebar + header hamburger below 900px (admin app was unusable on phones)"`

---

## Batch 5 — Tablet-band (768–1024) two-column collapse (one commit) [H8 H9 H10 H11]

Same class of bug: a two-column desktop layout doesn't stack in the iPad band, clipping the right column.

- [ ] **Step 1 — fixes:**
  - H8 `/invoice/:token`: constrain the grid so document + 280px `.invoice-actions` rail fit ≤1024 (raise the single-column breakpoint to ≥1100px, or shrink rail/main-max). Files: invoice page CSS/component.
  - H9 `/proposals/new` ProposalCreate: collapse the inner **Client | Event (| Package)** grid to one column at ≤~820px (currently only ≥1024). 
  - H10 `/events/:id` EventDetailPage: collapse the 2-col detail grid to single column below ~1000px (currently holds at 768).
  - H11 `/drink-plans/:id` `.page-actions`: `flex-wrap: wrap` + stack full-width under the title at ≤~768; give the "Save notes" textarea `width:100%`/`min-width:0`.
- [ ] **Step 2 — verify** at **768** and **1024** for each route: no inner element `right` exceeds `<main>` width; the right rail / action row is fully visible & reachable; no page horizontal scrollbar. ≥1440 unchanged.
- [ ] **Step 3 — commit:** `git commit -m "fix(responsive): collapse two-column layouts in the 768-1024 tablet band (invoice rail, ProposalCreate, event detail, drink-plan actions)"`

---

## Batch 6 — Standalone Highs (4 commits — genuinely independent)

Per CLAUDE.md, split only when independently revertable; these are (different files/concerns).

- [ ] **6a — `.icon-btn` ≥44px touch** `index.css:10691` (`html[data-app="admin-os"] .icon-btn`): add `@media (pointer:coarse)` min 44×44 hit area (padding or `::before` hit-box), keep 28×26 visual on desktop. Consumed by KebabMenu/Drawer/modal close everywhere. Verify: coarse-pointer 390, `getBoundingClientRect` of a row kebab + a drawer close ≥44×44; desktop visual unchanged. Commit: `fix(responsive): adminos .icon-btn >=44px hit area on touch`.
- [ ] **6b — Cocktail reorder touch fallback** `client/src/pages/admin/CocktailMenuDashboard.js:66-70,218-222`: add up/down move buttons per row (drinks + categories) wired to the existing reorder handler; keep HTML5 drag as a desktop enhancement. Verify: on a touch-emulated context, up/down reorders a row (drag is non-functional on touch — buttons are the fix). Commit: `fix(a11y): add up/down reorder buttons to CocktailMenuDashboard (drag is touch-dead)`.
- [ ] **6c — Quote-wizard stepper + spinners** [H5 H6]: make the 4-step stepper not overflow at 360–414 (stepper `overflow-x:auto` with `flex:0 0 auto` chips, or truncate `.wz-stepper-name` <420px); enlarge the duration/start-time spinner buttons to ≥44×44 touch area. Files: quoteWizard stepper component + `index.css` `.wz-stepper-name`/spinner rules. Verify: `/quote` @ 360/390/414 `scrollWidth == clientWidth` on every step; spinner buttons ≥44×44. Commit: `fix(responsive): quote wizard stepper no longer overflows mobile + larger spinner targets`.
- [ ] **6d — Plan "Review Your Menu" card (money path)** [H7]: the review-step `.card` is hardcoded `width:~426px; max-width:none` → replace with `width:100%; max-width:426px` (or the responsive container the other plan steps use). File: PotionPlanningLab review sub-step component / its CSS. Verify: `/plan/28390704-…` → Step 1 → Review Your Menu @ 360/390/414 `scrollWidth == clientWidth`; the "×" remove + Estimated-Costs block fully visible. **Money-path — also confirm pricing figures still render correctly.** Commit: `fix(responsive): plan Review-Your-Menu card fits mobile (was overflowing the money-path screen)`.

---

## Batch 7 — Post-C1 residual mobile passes (one commit) — DEPENDS ON Batch 4

These are masked by the sidebar today; they only become real (and verifiable) once `<main>` has real width on phones.

- [ ] **Step 1 — re-audit:** after Batch 4 is merged, re-run the runtime check at 360/390/414 (admin logged in) for `/events/:id`, `/drink-plans`, `/settings`, `/proposals/new`, `/dashboard`. Record true `main` vs content `scrollWidth`.
- [ ] **Step 2 — fix residuals** that still overflow with a full-width main:
  - `/events/:id` content min ~651px → remove fixed min-widths on rail/staffing/package cards so they shrink to 360. [R3b M]
  - `/drink-plans` list table 574px → stacked-card layout <600px. [R4a M]
  - `/settings` cocktail tables 599–780px → hide low-priority columns or stacked rows ≤~900px. [R4a M]
  - H12 `/settings` tab + sub-tab strips → `overflow-x:auto; flex-wrap:nowrap; white-space:nowrap` with a scroll hint (persists even with full-width main). [R4a H]
  - `/dashboard` KPI/stat grid → explicit mobile columns (1-up <480, 2-up 480–768). [R3a M]
- [ ] **Step 3 — verify** each at 360/390/414: `scrollWidth == clientWidth`, all columns/controls reachable.
- [ ] **Step 4 — commit:** `git commit -m "fix(responsive): admin detail/table/settings/KPI mobile passes (residuals exposed after the sidebar fix)"`

---

## Batch 8 — Medium / Low cleanup (1–2 commits)

Lower priority; batch last. Group: (a) **Medium** — `[S1]` `overflow:hidden` form/drawer cards audit, legacy `.admin-sidebar` `calc(100vh…)`→`dvh`, `.ws-hero-image-stack` max-height @≤640; `[S2]` `ClickableRow` add `onClick`/`onTouchEnd` path; `[R4b]` blog dash table + email filter inputs `flex-wrap`/`min-width:0`. (b) **Low/polish** — decorative <13px fonts nudge, optional `@media (max-width:400px)` pass, birth day/year `type="number"`→`type="text" inputMode="numeric"`, `.ws-menu-toggle` ≥44px, `ClientShoppingList` row toggle real checkbox/`role`+key handler, quote alert contrast, blog body max-width ~660px, OTP box width @360, Stripe `r.stripe.com` console-noise filter in Sentry (optional). Verify each by its audit repro. Commit(s): `fix(responsive): medium cleanup …` / `chore(polish): low-priority responsive polish …`.

---

## Parked — Staff portal (NOT a batch; blocked on a decision)

`[R5]` zero runtime coverage: `dallas@drbartender.com` 409s on the local DB **and** the staff portal is structurally unreachable on localhost (`getSiteContext()` maps localhost→`'app'`; staff portal mounts only on `staff.`/`hiring.` hosts). It cannot be fixed-and-verified until one of:
- a valid staff-status account exists in the local DB **and** a `staff.localhost`→127.0.0.1 host mapping is set, **or**
- a manual pass on the real `staff.drbartender.com`.

Note: the staff portal shares the adminos chrome + theme + input CSS, so **Batches 2, 3, 4 likely fix most of the staff portal too** — but that is unverifiable here. After Batches 2–4, re-evaluate the staff portal once a testing path exists. **User decision required** before this can be planned into batches.

---

## Self-review (against MERGED.md)

- **Coverage:** every MERGED Critical (C1→B4, C2→B3, C3→B2), all 13 Highs (H1→B0, H2→B1, H3/H4→B6, H5/H6→B6c, H7→B6d, H8–H11→B5, H12→B7, plus C3-class), Mediums (B5/B7/B8), Lows (B0/B8) mapped. Staff portal explicitly parked with reason. No finding dropped.
- **Dependency:** only B7→B4 is hard; encoded and stated twice.
- **No fabricated cascade:** systemic batches (B2/B3/B4) use investigate→transform→numeric-gate instead of invented CSS — a conscious, stated domain adaptation, not a placeholder.
- **Commit hygiene:** one logical commit per batch (B6 = 4 independent commits, justified); messages follow repo `fix(scope):` style; commit only on user cue; no push without push cue.
