# Mobile Fixes: design spec (2026-07-02)

Source: the 2026-07-02 mobile audit (local doc `.claude/mobile-audit-2026-07-02.md`, gitignored by convention; screenshots and probe data in `~/.playwright-mcp/mobile-audit/`). Every claim below carries the audit's verified file:line anchors. Anchor caveat from the spec-grounding review: `index.css` line numbers below ~12000 are exact; numbers above ~12000 have drifted about +15 lines since the audit. Every selector still resolves by name, so implementers locate by selector, not raw line number.

Reviewed by the spec fleet (grounding, gaps, risk) on 2026-07-02; all blockers and design-relevant warnings are folded into the text below.

Goal: make the app look and work right on phones, fixing the audited defects once, with a mechanism that keeps them fixed. Approved conversationally section by section with Dallas on 2026-07-02; per standing preference those approvals are the approval.

## Scope

In scope, four lanes in order:

1. **Lane 0, verification harness.** Committed capture-and-probe script; the merge gate for every later lane.
2. **Lane 1, corrections.** The seven audit P0s, two content bugs, the shared strip pattern, plus one approved addition (Potion Lab progress rail).
3. **Lane 2, pulled-forward usability.** Quote wizard mobile price bar (option A, bottom bar with Continue) and application scroll-to-first-error.
4. **Lane 3, mechanical sweep.** Tap targets, type floor, contrast, wrong-context button colors, Stripe element skeleton, small canvas/table fixes.

Out of scope, parked with owners:

- Admin card-ification and the admin filter strip: separate conversation (admin is outside the redesign scope).
- Staff bottom tab bar: goes in the staff-portal reskin prompt doc; it changes that surface's navigation feel.
- Portal archive reachability (`PortalHome.js:34` routes `archive` into the focus view when an active event exists) and the unbooked Prescription tab's two competing CTAs (`PrescriptionTab.js:68-69`): functional gaps, not mobile styling; fix-list candidates.
- Surfaces with no dev data to verify (compare, tip, feedback, populated shopping list, rostered shift detail, payout detail): the harness manifest marks them `skipped` so they stay visible.

## Lane 0: verification harness

New `scripts/mobile-capture.js` plus `scripts/mobile-capture.manifest.json`, run via `npm run mobile:check`. Dev-only tooling; never runs in CI.

- Drives installed system Chrome headless through `playwright-core` (new devDependency; no browser download) at viewport 390x844.
- The manifest lists every audited URL with: `name`, `path`, `host` (`public.localhost` | `staff.localhost` | `hiring.localhost` | `localhost`), `auth` (`none` | `staff` | `client` | `hired` | `admin`), optional `tokenQuery` (SQL to resolve a token-gated path from the dev DB at runtime, e.g. latest `sent` proposal token), optional `scrollableAllow` (CSS selectors of containers allowed to overflow horizontally, i.e. the strip-pattern containers), and optional `skipped: true` with a reason.
- **Environment gate (load-bearing, checked before any DB connection or token minting):** the script exits with an error when `NODE_ENV=production`, or when the `DATABASE_URL` host is not on a small allowlist of known dev hosts (the dev Neon branch hostname), or when `JWT_SECRET` is missing. Without this, a prod-pointing `.env` would mint valid production sessions and screenshot real client PII.
- Auth: mints JWTs at runtime from `.env` `JWT_SECRET` (staff and hired and admin payload `{ userId, tokenVersion }` into localStorage `token`; client payload `{ id, role: 'client', tokenVersion }` into `db_client_token`), matching `server/middleware/auth.js:37-47` and `:91-101`. Account ids live in the manifest (staff 5, client 19, hired 1488, admin 1).
- `tokenQuery` returning zero rows is a **loud per-page failure** (status `no-data`, listed in the summary, exit nonzero unless the page is marked `skipped`); the harness never navigates to a URL with an unresolved token, because an error page trivially passes the overflow probe and reads as a misleading green.
- Per page it captures a full-page screenshot into the `mobile-audit/` output directory at repo root and probes the DOM. That exact path is added to `.gitignore` **in the same change** (it is not covered today; only `.claude/mobile-audit-*` and `.playwright-mcp/` are), because the screenshots contain dev-DB client PII.
- **Fail conditions (exit nonzero):** document `scrollWidth > 390`; any element's bounding right edge beyond `viewport + 2px` unless inside a `scrollableAllow` container.
- **Report-only metrics (printed, never fail):** count of interactive elements under 36px in either dimension; count of leaf text nodes under 12px; console errors. These are the lane-by-lane scoreboard.
- Output: one summary table (page, pass/fail, offenders, metric counts) plus the screenshot directory for eyeballing.
- Docs: README npm-scripts table entry, one line in ARCHITECTURE if it touches nothing else, and `playwright-core` added to the CLAUDE.md Tech Stack dev-tools list.

## Lane 1: corrections

### Shared strip pattern

One CSS utility block in `index.css` (class `mob-strip` on the scroll container) plus a small helper:

- Hidden scrollbar, `scroll-snap-type: x proximity`, children `scroll-snap-align: start`.
- Right-edge affordance: a gradient fade element or mask shown only while the container can scroll further right (toggled by a few lines of JS or a scroll-driven class; implementation may choose mask-image with a scroll listener).
- Mobile padding tightened on the strip's items so the next item visibly peeks past the edge.
- Shared `scrollActiveIntoView(el)` helper (client util) so deep links center the active item.

Applied in this lane to:

- **Client portal tabs** `.cp-tabs` (`index.css:16873`, items `:16881`): tighten mobile padding and letter-spacing (`padding:14px 15px 12px; letter-spacing:0.13em` at max-width 640px), active tab centered on mount from `EventCommandCenter.js`. Do not abbreviate the labels.
- **Staff account sub-nav** `.sp-acc-nav` (`index.css:15758-15768`, buttons `:15769-15785`): same treatment; `AccountPage.js:139-155` centers the active button on section change.

### Quote wizard stepper (P0 1)

Below 720px, replace the five-cell strip with a compact single brass-bordered line, "Step III of V, Package" (roman numeral plus current step name, matching the existing cell typography). Desktop strip untouched. This supersedes the inert `grid-template-columns: 1fr` rule at `index.css:5466`; remove that rule. Component: the stepper markup in `QuoteWizard.js` renders the compact variant from the same steps array (`QuoteWizard.js:632-646`), so labels can never drift.

Accepted regression, explicit: the desktop cells are clickable jump-back buttons (`replaceStep`, `QuoteWizard.js:641`); the compact line is not, so mobile users lose multi-step jump-back. The one-step Back button and the Review step's per-section edit links remain, which covers the real flows.

### Onboarding progress (P0 6)

Below 640px, hide `.steps-track` (`index.css:1109-1126`) and render "Step N of 7, Welcome" plus the existing `.progress-track`/`.progress-fill` bar that `Layout.js:85-89` already computes. Step labels stay >= 12px.

### Staff portal skin collision (P0 3)

- Blocking inline script in `client/public/index.html` that sets `data-app` and `data-skin` on `<html>` before first paint for the staff host. **This is a new pattern, not a mirror**: `index.html` has no inline script today, and admin-os sets `data-app` via a post-paint React effect (`AdminLayout.js:21`), which is exactly the mechanism being fixed. The script: gated strictly on the staff hostname (inert on every other host), reads the new localStorage mirror key (below), whitelists the value to `dark` or `light` before writing any attribute (never writes a raw localStorage string into the DOM), falls back to `prefers-color-scheme`, and tolerates localStorage being unavailable (private mode) by falling through to the media query.
- **New localStorage mirror:** the skin preference is persisted server-side only today (`/me/ui-preferences`, fetched post-mount in `StaffShellWithThemeWiring.js:91`), so there is nothing local for a pre-paint script to read. The theme wiring gains a one-line mirror write of the resolved skin to a named localStorage key whenever the skin is set or changed; the pre-paint script reads that key. First-ever visit on a device can still flash once (nothing mirrored yet); every later visit is flash-free.
- `StaffShell.js` deletes `data-app` on unmount; after a portal-to-login navigation the neutralizer would drop. The pre-paint script's hostname gate plus re-applying `data-app` on the login route of the staff host (or simply not deleting it when the hostname is staff) closes that small flash window; implementer picks the cleaner of the two.
- `:root` fallbacks for `--sp-bg-0/1/2/3` (and any sibling `--sp-*` surface vars) so an unset `data-skin` can never resolve them to transparent (`index.css:14032`, `:14063`).
- Extend the background neutralizer from `html[data-app="staff"] body` (`index.css:14527-14530`) to also cover `html[data-app="staff"]` itself.
- Light-skin `.sp-card` (`index.css:14409`) and `.sp-shift` (`:14200`) get an opaque paper surface instead of `transparent`.
- `StaffShell.js:77-92` and `StaffShellWithThemeWiring.js:88-110` keep working as the post-paint authority; the pre-paint script only prevents the flash and the transparent-var window.

### Staff notification toggles (P0 4)

Add the missing switch CSS: `.sp-toggle` track (~40x24), sliding `.sp-toggle-thumb`, `.on` state colored with the skin accent, `.disabled` dimmed, min 44px hit area (padding beyond the visual track). Markup already correct in `NotificationsSection.js:541-560`; no JS changes.

### Proposal chalkboard 404 (P0 7)

`proposalView/styles.js:16`: import `client/src/images/chalkboard_background.png` and use the import in the style object. Do not copy the PNG into `public/`.

### /apply header overflow (P0 5)

At max-width 640px: hide `.header-user` (`index.css:1092-1097`), tighten `.site-header` padding (`index.css:1023-1034`) to `0.75rem 1rem`, add `flex-wrap: wrap` as a belt. Fixes the header, not the wrapper.

### Content bug: package-includes interpolation

New shared helper `interpolatePackageIncludes(text, ctx)` in `client/src/utils/` replacing the three existing inline copies (`ProposalView.js:434`, `ProposalDetail.js:326`, `EventDetailPage.js:152`) and adding the missing fourth consumer (`PrescriptionTab.js:50-54`). Tokens: `{bartenders}`, `{bartenders_s}`, `{hours}`. Cross-cutting rule applies: all four call sites move to the helper in the same change.

### Content bug: blog placeholder leak

`Blog.js:86-90` and `:126-129`: when `cover_image_url` is null on the public blog, render a branded parchment/flask block (reuse existing brand classes) instead of the striped `img-placeholder` with dev text. Separately, Dallas uploads a cover image for the current featured post (code cannot fix the missing asset).

### Approved addition: Potion Lab progress rail

Mount the already-styled `.potion-rail` ticks (`index.css:12984-12995`) from `PotionPlanningLab.js:936-940` (one tick per module-queue entry plus confirmation, `done`/`active` classes by index), and fix the subscript-looking numeral with `font-variant-numeric: lining-nums` (or body font) on the counter line.

## Lane 2: pulled-forward usability

### Quote wizard mobile price bar (option A)

New `WizardPriceBar` component rendered by `QuoteWizard.js`. **Breakpoint: 900px and below**, matching the existing `.wz-sidebar { order: -1 }` block (`index.css:7288`); a narrower breakpoint would leave the 721-900px band with the empty stacked sidebar and no bar. The compact stepper may keep its own 720px breakpoint; the bar and the sidebar suppression move together at 900px.

- Fixed to the viewport bottom. Right side: the step's primary action. On steps with Continue, the Continue button (moves out of the in-flow `.wz-nav` on mobile; Back stays in-flow at the form bottom with the Lane 3 contrast fix). **On the final step, the bar renders the same guarded submit control** ("Send proposal", `handleSubmit` with `disabled={submitting}`, `QuoteWizard.js:796-806`), the exact existing handler and guard, never a fresh duplicate button; the in-flight guard is load-bearing because submit creates a real proposal and lead, and an unguarded second button would let a mobile double-tap create duplicates.
- Left side: "The Prescription, $1,100" once `preview` exists (`QuoteWizard.js:769-771`); nothing on the left before that.
- Tapping the price opens a bottom sheet showing the Prescription breakdown. The breakdown is currently inline JSX (`.wz-price-card`, `QuoteWizard.js:731-772`), so it gets extracted into a small component first and rendered from both the desktop sidebar and the mobile sheet. Sheet dismissal: tap-out or close control; body scroll locks while open.
- Keyboard behavior: the bar hides while a text input is focused (focusin/focusout on the form region), the standard answer to iOS keyboards fighting `position: fixed; bottom: 0` bars. The contact step is where this bites.
- On mobile the in-flow sidebar panel stops rendering entirely, which removes the empty placeholder above steps I and II.
- Clearance: the bottom padding that keeps content clear of the bar goes on the wizard section around `.wz-nav` (the `FormBanner` is a sibling rendered after `.wz-body`, `QuoteWizard.js:776`, not inside the form column, so padding the form column alone would leave the banner hidden behind the bar).
- Safe area: `padding-bottom: env(safe-area-inset-bottom)` on the bar.
- Desktop sticky sidebar behavior untouched.

### Application scroll-to-first-error

In the validation-failure branch of the submit handler in `Application.js` (the handler starts around `:132`; `:663` is only the button JSX): `document.querySelector('[aria-invalid="true"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })` plus focus. All three pages already render `aria-invalid`, so the selector has real targets. Mirror the same lines in `Agreement.js` and `ContractorProfile.js`, which share the pattern and the gap. (Section progress and draft autosave stay out of scope for now.)

## Lane 3: mechanical sweep

No behavior changes. CSS unless noted.

- Footer links: `display:inline-block; padding:10px 0` on `.ws-footer-col a` (`index.css:4071`), list gap compensated; same for Office links. Utility strip links padded (`index.css:3439-3443`).
- Drawer CTA centered: `justify-content:center` on `.ws-mobile-drawer .ws-nav-cta` (the `text-align` at `index.css:3605` is inert on flex; remove it).
- Hamburger hit area to >= 44px (`index.css:3564-3580`).
- Wizard info icons `.wz-tile-info` (`index.css:6258-6263`) and `.wz-skip-inline` (`:5842-5854`) padded hit areas; TimePicker/NumberStepper arrows grown under `pointer: coarse` (`index.css:10188-10199`, `:10328-10340`).
- Potion remove chips `.your-menu-extra-tag.removable` (`index.css:2294-2319`) to min-height 32px with a padded remove target; drink list `padding-bottom: 72px` on `.drink-card-list` (`index.css:2950`) so the sticky bar cannot cover the last card or an expanded upgrade panel.
- Staff: Request button `sp-btn-sm` to `sp-btn` (`ShiftsPage.js:471-473`); inputs to 16px (`.sp-tf-input` `index.css:15867`, `.sp-pm-input` `:16211`, `.sp-modal-input` `:15292` block), the real iOS zoom fix; muted meta 10-11px raised to 12px and `--sp-ink-3`/`--sp-ink-4` usage on the shifts meta promoted a tone (`index.css:14217-14300`); account nav buttons to >= 36px tall; profile labels/helpers to 12-13px (`index.css:15834-15886`).
- Invoice: table wrapped in `overflow-x:auto` (or stacked under 480px) with `white-space:nowrap` on money cells (`index.css:9318-9339`); type floor to 12px for the 9-11px nodes (`:9251`, `:9258`, `:9388`, `:9461`); `overflow-wrap:anywhere` on `.invoice-meta-line` (`:9311`).
- Wrong-context colors: quote `.wz-nav .btn-secondary` to cream text and brass border with matching hover (`index.css:6695-6710`); Receipts Share `.cp-receipt-row .client-btn-outline` to deep-brown on parchment (`index.css:8321-8324`, `ShareButton.js:12`); disabled pay button replaces `opacity:0.45 + grayscale` with a solid muted fill and dark readable label (`PaymentForm.js:55-60`, `styles.js:232-246`). The restyle touches only the style objects, **never the disabled condition** (`!stripe || paying || disabled`, `PaymentForm.js:54`); a still-loading or mid-payment button must stay unclickable.
- Stripe element: `min-height: ~180px` on `.sign-pay-stripe-wrap` (`index.css:9813-9818`) and a "Loading secure payment..." skeleton until `PaymentElement` `onReady`. **The skeleton overlays; it never conditionally replaces the element.** `PaymentElement` stays mounted underneath (CSS overlay), and the skeleton auto-reveals the area on a timeout (~10s) so a client whose network blocks Stripe still sees whatever state exists instead of an eternal skeleton; if the element genuinely cannot mount, the failure is visible, not masked. This change spans two files: the element and pay button live in `PaymentForm.js:46-64`; the wrap, the `loadingIntent` spinner, and the `!activeSecret` fallback live in `SignAndPaySection.js` (`:95`, `:117`, `:405`), and both spinner and fallback stay.
- Signature canvas DPR scaling: multiply the backing store by `devicePixelRatio` and `ctx.scale()` (`SignaturePad.js:38-44`). Setting `canvas.width` resets the 2D transform and the resize runs on mount and every resize, so the scale must be re-applied on every width set, not once. This is the legally binding contract signature: verified before merge by actually signing on a real high-DPR phone, not just by the harness (which never draws). Signature mode/Accept/Clear buttons to ~40px.
- Rename the duplicated `.proposal-layout` (public view copy at `index.css:9521`, used by `ProposalView.js:498`) to `.proposal-view-layout` to defuse the collision with the admin create form's `:1311` block.

## Sequencing, gates, review

- Order: Lane 0, then 1, then 2, then 3. Lanes 1 and 3 both edit `index.css`; they run serially, never in parallel windows, to avoid churn in the shared file.
- Merge gate per lane: `npm run mobile:check` passes for the lane's surfaces (no fails; report metrics moving the right way) plus a before/after screenshot eyeball. Lane 0 establishes the baseline run against current main.
- Review scaling: no touched file is on `scripts/sensitive-paths.txt`, so the formal level is light. Voluntary exception: Lane 3's sign-and-pay touches (PaymentForm, SignAndPaySection, styles.js) get one focused reviewer on the diff.
- The client build gate applies as usual (`CI=true react-scripts build` via the pre-push hook when client/ changes).

## Risks and notes

- `index.css` is shared and hot across parallel windows; the serial-lane rule above is the mitigation. Quick fixes from other windows that land between lanes get picked up by re-running the harness baseline.
- The price bar changes the primary action's location on mobile; the harness screenshot pass plus a manual phone walk of all five steps before merge covers the interaction risk (validation banner, keyboard hide/show, sheet dismissal, final-step submit).
- The staff pre-paint script must stay tiny and inert for non-staff hosts. It is a new pattern for this codebase (nothing pre-paint exists today); the design constraints in Lane 1 (hostname gate, value whitelist, localStorage-unavailable fallback) are what keep it safe.
- The harness's runtime token queries hit the shared dev DB read-only; drink-plan URLs must use a draft plan (auto-save mutates state when a plan page is driven; capture-only navigation does not submit but the welcome resume can advance a step pointer).
- Report-only metrics (tap targets, tiny text) are deliberately not fail conditions in Lane 0; Lane 3 is expected to drive them near zero, after which tightening them into fail conditions is a one-line manifest change if we want it.
