---
plan: mobile-fixes
spec: docs/superpowers/specs/2026-07-02-mobile-fixes-design.md
lanes:
  - id: mobile-harness
    footprint:
      - scripts/mobile-capture.js
      - scripts/mobile-capture.manifest.json
      - .gitignore
      - package.json
      - package-lock.json
      - README.md
      - ARCHITECTURE.md
      - .claude/CLAUDE.md
    deps: []
    review: light
  - id: mobile-corrections
    footprint:
      - client/src/index.css
      - client/public/index.html
      - client/src/components/StaffShellWithThemeWiring.js
      - client/src/components/StaffShell.js
      - client/src/components/Layout.js
      - client/src/pages/website/quoteWizard/QuoteWizard.js
      - client/src/pages/proposal/proposalView/styles.js
      - client/src/pages/public/portal/EventCommandCenter.js
      - client/src/pages/staff/account/AccountPage.js
      - client/src/pages/public/portal/tabs/PrescriptionTab.js
      - client/src/pages/public/portal/tabs/PrescriptionTab.test.js
      - client/src/pages/proposal/proposalView/ProposalView.js
      - client/src/pages/admin/ProposalDetail.js
      - client/src/pages/admin/EventDetailPage.js
      - client/src/utils/packageIncludes.js
      - client/src/utils/packageIncludes.test.js
      - client/src/utils/stripNav.js
      - client/src/pages/public/Blog.js
      - client/src/pages/plan/PotionPlanningLab.js
    deps: [mobile-harness]
    review: light
  - id: mobile-pricebar
    footprint:
      - client/src/pages/website/quoteWizard/QuoteWizard.js
      - client/src/pages/website/quoteWizard/WizardPriceBar.js
      - client/src/pages/website/quoteWizard/PrescriptionCard.js
      - client/src/index.css
      - client/src/pages/Application.js
      - client/src/pages/Agreement.js
      - client/src/pages/ContractorProfile.js
    deps: [mobile-corrections]
    review: light
  - id: mobile-sweep
    footprint:
      - client/src/index.css
      - client/src/pages/proposal/proposalView/PaymentForm.js
      - client/src/pages/proposal/proposalView/SignAndPaySection.js
      - client/src/pages/proposal/proposalView/styles.js
      - client/src/pages/proposal/proposalView/ProposalView.js
      - client/src/pages/invoice/InvoicePage.js
      - client/src/components/SignaturePad.js
      - client/src/pages/staff/ShiftsPage.js
      - client/src/pages/public/portal/ShareButton.js
    deps: [mobile-pricebar]
    review: light plus one focused reviewer on the sign-and-pay diff (PaymentForm, SignAndPaySection, styles.js)
---

# Mobile Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the spec first: `docs/superpowers/specs/2026-07-02-mobile-fixes-design.md`.

**Goal:** Fix every audited mobile defect (7 P0s, 2 content bugs, the pulled-forward usability pair, the mechanical sweep) with a committed verification harness gating each lane.

**Architecture:** Four serial lanes. Lane order exists because three lanes edit the shared `client/src/index.css` and must never run in parallel windows. The harness (Lane A) lands first and provides the merge gate for B, C, D: `npm run mobile:check` must pass for a lane's surfaces plus a before/after screenshot eyeball.

**Tech Stack:** React 18 (CRA), vanilla CSS in `index.css`, Node scripts, `playwright-core` (new devDependency) driving installed system Chrome.

## Global Constraints

- Vanilla CSS only; no Tailwind, no CSS modules, no preprocessors (CLAUDE.md invariant).
- `index.css` anchors below ~line 12000 are exact; above that they have drifted about +15 lines. Always locate by selector, never trust a raw line number.
- No em dashes in any client-facing copy.
- Root font stays 17px and form inputs stay at or above 0.95rem; that is what keeps rem-based inputs above the 16px iOS zoom threshold. Never lower either.
- The pre-commit file-size ratchet applies to `client/src/**/*.{js,jsx}`; new files aim under 300 lines.
- Explicit git staging only (`git add <path>`); lane checkpoints commit freely inside the lane, squash-merge is the unit.
- The client build gate: any lane touching `client/` finishes with `cd client && CI=true npx react-scripts build` clean (pre-push runs it anyway; run it at lane end to fail fast).
- Client unit tests run per-file: `cd client && CI=true npx react-scripts test --watchAll=false <path>`.

---

## Lane A: mobile-harness

### Task A1: capture script with environment gate

**Files:**
- Create: `scripts/mobile-capture.js`
- Create: `scripts/mobile-capture.manifest.json`
- Modify: `.gitignore` (add `/mobile-audit/`)
- Modify: `package.json` (devDependency + script)

**Interfaces:**
- Produces: `npm run mobile:check [-- --only <name,...>]`, exit 0 = all non-skipped pages pass; screenshots + `report.json` in `/mobile-audit/`.

- [ ] **Step 1: dependency + script.** `npm install --save-dev playwright-core`. Add to `package.json` scripts: `"mobile:check": "node scripts/mobile-capture.js"`.

- [ ] **Step 2: gitignore.** Add `/mobile-audit/` to `.gitignore` (screenshots contain dev-DB client PII; not covered by any existing pattern).

- [ ] **Step 3: write the script.** Skeleton (complete logic; the audit's working probe is embedded):

```js
#!/usr/bin/env node
/* Mobile verification harness. Dev-only: refuses prod. Spec: docs/superpowers/specs/2026-07-02-mobile-fixes-design.md (Lane 0). */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { URL } = require('node:url');

function die(msg) { console.error('[mobile:check] ' + msg); process.exit(1); }

// ---- Environment gate: BEFORE any DB connection or token minting ----
if (process.env.NODE_ENV === 'production') die('refusing to run: NODE_ENV=production');
if (!process.env.DATABASE_URL) die('DATABASE_URL missing');
if (!process.env.JWT_SECRET) die('JWT_SECRET missing');
const DEV_DB_HOSTS = ['DEV_NEON_HOST_HERE']; // exact hostname of the dev Neon branch, copied from os/.env at implementation time
const dbHost = new URL(process.env.DATABASE_URL).hostname;
if (!DEV_DB_HOSTS.includes(dbHost)) die(`refusing to run: DATABASE_URL host "${dbHost}" is not the dev branch`);

const { chromium } = require('playwright-core');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'mobile-capture.manifest.json'), 'utf8'));
const OUT = path.join(__dirname, '..', 'mobile-audit');
fs.mkdirSync(OUT, { recursive: true });

const only = (() => { const i = process.argv.indexOf('--only'); return i > -1 ? process.argv[i + 1].split(',') : null; })();

function mintToken(auth) {
  const a = manifest.accounts[auth];
  if (!a) die(`unknown auth kind ${auth}`);
  const payload = auth === 'client'
    ? { id: a.id, role: 'client', tokenVersion: a.tokenVersion }
    : { userId: a.id, tokenVersion: a.tokenVersion };
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '2h' });
}

async function probe(page, allowSelectors) {
  return page.evaluate((allow) => {
    const vw = window.innerWidth;
    const allowed = (el) => allow.some((sel) => el.closest(sel));
    const out = { scrollW: document.documentElement.scrollWidth, offRight: [], smallTaps: 0, tinyText: 0 };
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 2 && !allowed(el) && out.offRight.length < 10) {
        const cls = typeof el.className === 'string' ? el.className.split(' ').slice(0, 3).join('.') : '';
        out.offRight.push(el.tagName.toLowerCase() + (cls ? '.' + cls : '') + ' right=' + Math.round(r.right));
      }
    });
    document.querySelectorAll('a,button,input,select,textarea,[role="button"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && (r.height < 36 || r.width < 36)) out.smallTaps++;
    });
    document.querySelectorAll('p,span,li,td,label,a').forEach((el) => {
      if (el.children.length === 0 && el.textContent.trim().length > 10
          && parseFloat(getComputedStyle(el).fontSize) < 12) out.tinyText++;
    });
    return out;
  }, allowSelectors);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const browser = await chromium.launch({ executablePath: manifest.chromePath, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const results = [];
  let consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 120)); });

  for (const entry of manifest.pages) {
    if (only && !only.includes(entry.name)) continue;
    if (entry.skipped) { results.push({ name: entry.name, status: 'skipped', reason: entry.skipped }); continue; }
    let urlPath = entry.path;
    if (entry.tokenQuery) {
      const { rows } = await pool.query(entry.tokenQuery);
      if (!rows[0] || !rows[0].token) { results.push({ name: entry.name, status: 'no-data' }); continue; }
      urlPath = entry.path.replace(':token', rows[0].token);
    }
    const origin = `http://${entry.host}:3000`;
    if (entry.auth && entry.auth !== 'none') {
      await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
      const key = entry.auth === 'client' ? 'db_client_token' : 'token';
      await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, mintToken(entry.auth)]);
    }
    consoleErrors = [];
    await page.goto(origin + urlPath, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(entry.settleMs || 2200);
    if (entry.auth && entry.auth !== 'none') {
      // Every authed entry MUST set authAssert: a selector that only renders logged-in
      // (e.g. '.cp-tabs' for the portal, '.sp-tabs' for staff). Without this a stale
      // tokenVersion or gated account renders logged-out and would false-green the probe.
      if (!entry.authAssert) { results.push({ name: entry.name, status: 'auth-failed', reason: 'authAssert missing in manifest' }); continue; }
      const ok = await page.locator(entry.authAssert).first().isVisible().catch(() => false);
      if (!ok) { results.push({ name: entry.name, status: 'auth-failed' }); continue; }
    }
    await page.screenshot({ path: path.join(OUT, entry.name + '.jpeg'), fullPage: true, type: 'jpeg', quality: 82 });
    const p = await probe(page, entry.scrollableAllow || []);
    const pass = p.scrollW <= 390 && p.offRight.length === 0; // spec: fail above 390, no tolerance
    results.push({ name: entry.name, status: pass ? 'pass' : 'FAIL', ...p, consoleErrors: consoleErrors.slice(0, 3) });
  }

  await browser.close(); await pool.end();
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2));
  const w = (s) => String(s).padEnd(30);
  for (const r of results) console.log(w(r.name), r.status.padEnd(11), r.offRight ? r.offRight.join(' | ') : '', r.smallTaps != null ? `taps<36:${r.smallTaps} tiny<12:${r.tinyText}` : '', r.consoleErrors && r.consoleErrors.length ? `console:${r.consoleErrors.length}` : '');
  const bad = results.filter((r) => r.status === 'FAIL' || r.status === 'no-data' || r.status === 'auth-failed');
  if (bad.length) die(`${bad.length} page(s) FAIL, no-data, or auth-failed`);
  console.log(`[mobile:check] ${results.filter((r) => r.status === 'pass').length} pass, ${results.filter((r) => r.status === 'skipped').length} skipped`);
})();
```

- [ ] **Step 4: write the manifest.** Shape (fill all audited pages; the full URL list is in the audit doc's method notes and the session capture scripts):

```json
{
  "chromePath": "/opt/google/chrome/chrome",
  "accounts": {
    "staff": { "id": 5, "tokenVersion": 0 },
    "client": { "id": 19, "tokenVersion": 0 },
    "hired": { "id": 1488, "tokenVersion": 0 },
    "admin": { "id": 1, "tokenVersion": 0 }
  },
  "pages": [
    { "name": "home", "host": "public.localhost", "path": "/", "auth": "none" },
    { "name": "quote", "host": "public.localhost", "path": "/quote", "auth": "none" },
    { "name": "proposal-sent", "host": "public.localhost", "path": "/proposal/:token", "auth": "none",
      "tokenQuery": "SELECT token FROM proposals WHERE status='sent' ORDER BY id DESC LIMIT 1" },
    { "name": "plan-welcome", "host": "public.localhost", "path": "/plan/:token", "auth": "none",
      "tokenQuery": "SELECT token FROM drink_plans WHERE status='draft' ORDER BY id DESC LIMIT 1" },
    { "name": "portal-home", "host": "public.localhost", "path": "/my-proposals", "auth": "client",
      "authAssert": ".cp-tabs", "scrollableAllow": [".cp-tabs"] },
    { "name": "staff-account-profile", "host": "staff.localhost", "path": "/account/profile", "auth": "staff",
      "authAssert": ".sp-acc-nav", "scrollableAllow": [".sp-acc-nav"] },
    { "name": "compare", "host": "public.localhost", "path": "/compare/:token", "skipped": "no proposal_groups rows in dev" }
  ]
}
```

Full page list to include: home, services, method, about, faq, labnotes, labnotes-post (tokenQuery on blog slug is not needed; use the index), client-login, quote, classes, labrat, proposal-sent, proposal-paid, plan-welcome, invoice, shopping-list, portal-home, portal-archive, staff dashboard/shifts/shifts-mine/pay/tip-card/account x5, hiring landing/login/register/forgot-password, onboarding welcome/field-guide/agreement/contractor-profile/payday-protocols, apply, admin home/events/proposals/messages, plus `skipped` entries for compare, tip, feedback, populated shopping list, payout detail, rostered shift detail.

- [ ] **Step 5: verify manifest accounts, then baseline run.** First check each manifest account's live row in the dev DB (`SELECT token_version, onboarding_status FROM users WHERE id IN (5, 1488, 1); SELECT token_version FROM clients WHERE id=19;`) and correct the manifest's `tokenVersion` values (and swap accounts if one has been deactivated). Dev servers up (client :3000, server :5000 with `NODE_ENV=development`). Run `npm run mobile:check`. Expected on current main: FAILs exactly on the audited P0 surfaces (quote wizard steps, apply, onboarding pages), `auth-failed` on none, passes elsewhere; `smallTaps`/`tinyText` counts are the baseline scoreboard. Record the summary table in the lane's squash-commit body.

- [ ] **Step 6: docs + commit.** README npm-scripts table row, including the note that `mobile:check` is EXPECTED to stay red on main until the mobile-sweep lane lands (the baseline failures are the audited P0s; red mid-project is not a regression); one ARCHITECTURE line (dev tooling); `playwright-core` added to CLAUDE.md Tech Stack dev-tools list. Commit the lane.

---

## Lane B: mobile-corrections

Every task ends with `npm run mobile:check -- --only <affected pages>` and an eyeball of the new screenshots. Locate all CSS by selector.

### Task B1: strip utility + portal tabs + staff account nav

**Files:**
- Modify: `client/src/index.css` (new utility block + two surface tweaks)
- Create: `client/src/utils/stripNav.js`
- Modify: `client/src/pages/public/portal/EventCommandCenter.js`, `client/src/pages/staff/account/AccountPage.js`

**Interfaces:**
- Produces: CSS class `mob-strip` (container) and helper `scrollActiveIntoView(container, activeEl)` used by any horizontal nav strip.

- [ ] **Step 1: utility CSS** (new block near the shared primitives in `index.css`):

```css
/* Horizontal nav strip, phone-safe: hidden scrollbar, snap, right-edge fade cue. */
.mob-strip {
  overflow-x: auto;
  scroll-snap-type: x proximity;
  scrollbar-width: none;
  -ms-overflow-style: none;
  -webkit-mask-image: linear-gradient(90deg, #000 86%, transparent 100%);
          mask-image: linear-gradient(90deg, #000 86%, transparent 100%);
}
.mob-strip::-webkit-scrollbar { display: none; }
.mob-strip.at-end {
  -webkit-mask-image: none;
          mask-image: none;
}
.mob-strip > * { scroll-snap-align: start; }
```

- [ ] **Step 2: helper** `client/src/utils/stripNav.js`:

```js
// Shared behavior for .mob-strip horizontal nav strips.
export function scrollActiveIntoView(container, activeEl) {
  if (!container || !activeEl) return;
  activeEl.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'auto' });
}

// Toggles .at-end so the fade cue disappears when fully scrolled. Returns cleanup.
export function wireStripFade(container) {
  if (!container) return () => {};
  const update = () => {
    const end = container.scrollLeft + container.clientWidth >= container.scrollWidth - 2;
    container.classList.toggle('at-end', end);
  };
  update();
  container.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  return () => { container.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
}
```

Note: when content fits entirely, `scrollLeft + clientWidth >= scrollWidth` is true at rest, so `at-end` applies and no fade shows. That is the no-overflow case handled.

- [ ] **Step 3: portal tabs.** Add `mob-strip` to the `.cp-tabs` container className in `EventCommandCenter.js`; in a `useEffect` on tab change call both helpers (ref on the container; the active tab renders `.active` + `aria-selected`, NOT `aria-current`, so target `.active` or `[aria-selected="true"]`). `EventCommandCenter.js` currently imports only React; add the `useEffect`/`useRef` imports. CSS: under `@media (max-width: 640px)` add `.cp-tab { padding: 14px 15px 12px; letter-spacing: 0.13em; }` (locate `.cp-tab` by selector). Do not abbreviate labels.

- [ ] **Step 4: staff account nav.** Same treatment: `mob-strip` on `.sp-acc-nav`, helpers wired in `AccountPage.js` on section change, and bump `.sp-acc-navbtn` vertical padding to reach 36px height.

- [ ] **Step 5: verify.** `npm run mobile:check -- --only portal-home,staff-account-profile,staff-account-payments` passes (their `scrollableAllow` covers the strip); eyeball: fade cue visible, next tab peeking. Commit.

### Task B2: quote stepper compact line

**Files:**
- Modify: `client/src/pages/website/quoteWizard/QuoteWizard.js` (stepper block at ~`:632-646`)
- Modify: `client/src/index.css` (`.wz-stepper` media block; remove the inert `grid-template-columns: 1fr`)

- [ ] **Step 1: JSX.** After the existing `.wz-stepper` div, render the compact variant from the same array:

```jsx
<div className="wz-stepper-compact" aria-label="Quote progress">
  <span className="wz-stepper-roman">Step {ROMANS[step] || step + 1} of {ROMANS[steps.length - 1] || steps.length}</span>
  <span className="wz-stepper-name">{steps[step].label}</span>
</div>
```

- [ ] **Step 2: CSS.** Desktop hides compact; mobile swaps:

```css
.wz-stepper-compact {
  display: none;
  align-items: baseline;
  gap: 12px;
  justify-content: center;
  border: 1px solid rgba(184, 146, 74, 0.4);
  background: rgba(18, 22, 28, 0.5);
  margin: 0 auto 2rem;
  padding: 12px 16px;
}
@media (max-width: 720px) {
  .wz-stepper { display: none; }
  .wz-stepper-compact { display: flex; }
}
```

In the existing `@media (max-width: 720px)` block, delete the inert `.wz-stepper { grid-template-columns: 1fr; }` rule and the now-dead `.wz-stepper-cell` row rules.

Accepted regression (spec): mobile loses multi-step jump-back; Back button and Review-step edit links remain.

- [ ] **Step 3: verify.** `npm run mobile:check -- --only quote` (quote page FAIL from the stepper overflow should flip to pass); eyeball at 390 and at 760 (desktop strip intact). Commit.

### Task B3: onboarding progress compact line

**Files:**
- Modify: `client/src/components/Layout.js` (steps bar block at ~`:60-91`)
- Modify: `client/src/index.css` (`.steps-track`, `.step-item` media handling)

- [ ] **Step 1: JSX.** Next to the existing `.steps-track`, using the same `STEPS` array and the fill percent already computed at `Layout.js:45-46`:

```jsx
<div className="steps-compact">
  Step {currentStepIndex + 1} of {STEPS.length}: {STEPS[currentStepIndex].label}
</div>
```

(`currentStepIndex` is the existing variable at `Layout.js:36` that already marks the active `.step-item`; reuse it, do not recompute.)

- [ ] **Step 2: CSS.**

```css
.steps-compact { display: none; font-size: 0.85rem; letter-spacing: 0.04em; text-align: center; padding: 4px 0 8px; }
@media (max-width: 640px) {
  .steps-track { display: none; }
  .steps-compact { display: block; }
}
```

The existing `.progress-track`/`.progress-fill` bar stays visible on all widths.

- [ ] **Step 3: verify.** `npm run mobile:check -- --only onboarding-welcome,onboarding-agreement` flips to pass. Commit.

### Task B4: staff pre-paint skin script + var fallbacks + opaque cards

**Files:**
- Modify: `client/public/index.html`, `client/src/components/StaffShellWithThemeWiring.js`, `client/src/components/StaffShell.js`, `client/src/index.css`

**Interfaces:**
- Produces: localStorage key `sp-skin` (values `dark` | `light`), the contract between the theme wiring and the pre-paint script.

- [ ] **Step 1: inline script** in `client/public/index.html` `<head>`, before any stylesheet link:

```html
<script>
  (function () {
    try {
      if (location.hostname.indexOf('staff.') !== 0) return;
      var d = document.documentElement;
      d.setAttribute('data-app', 'staff');
      var s = null;
      try { s = localStorage.getItem('sp-skin'); } catch (e) {}
      if (s !== 'dark' && s !== 'light') {
        s = (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
      }
      d.setAttribute('data-skin', s);
    } catch (e) {}
  })();
</script>
```

Whitelist enforced (only the two literals reach `setAttribute`); inert on every non-staff host; tolerates unavailable localStorage.

- [ ] **Step 2: mirror write.** In `StaffShellWithThemeWiring.js` where the resolved skin is applied (the effect around `:88-110`) and in `StaffShell.js` where `data-skin` is set (`:77-92`), add: `try { localStorage.setItem('sp-skin', skin); } catch (e) {}` with the same `sp-skin` literal.

- [ ] **Step 3: unmount flash.** In `StaffShell.js`'s cleanup that deletes `dataset.app`, skip the delete when `location.hostname.startsWith('staff.')` (the pre-paint script owns it on that host).

- [ ] **Step 4: CSS fallbacks + opacity.** In `index.css`: copy the full `--sp-bg-0/1/2/3` (and sibling `--sp-*` surface vars) from the `[data-skin="dark"]` block (locate by searching `--sp-bg-0`) into `:root` so unset `data-skin` can never resolve transparent. Extend the neutralizer: locate `html[data-app="staff"] body` and add a sibling rule `html[data-app="staff"] { background: var(--sp-bg-0); }`. Give light-skin `.sp-card` and `.sp-shift` (locate `[data-skin="light"] .sp-card` / `.sp-shift`) an opaque background (`var(--sp-bg-1)` or the paper value used elsewhere in that block) instead of `transparent`.

- [ ] **Step 5: verify.** `npm run mobile:check -- --only staff-dashboard,staff-pay,staff-shifts`; eyeball: no chalkboard texture anywhere in the staff shell, both skins, and hard-reload shows no flash (throttle network in devtools to confirm). Commit.

### Task B5: staff notification toggle CSS

**Files:** Modify: `client/src/index.css` (new block near the other `.sp-notif` rules; markup already correct in `NotificationsSection.js:541-560`).

- [ ] **Step 1: CSS.**

```css
.sp-toggle {
  position: relative;
  width: 40px; height: 24px;
  border-radius: 12px;
  border: 1px solid var(--sp-ink-4, #565d69);
  background: var(--sp-bg-2, #1b212b);
  padding: 10px; /* grows the hit area toward 44px */
  background-clip: content-box;
  box-sizing: content-box;
  cursor: pointer;
  transition: background-color 0.15s ease;
}
.sp-toggle-thumb {
  position: absolute;
  top: 50%; left: 12px;
  width: 20px; height: 20px;
  margin-top: -10px;
  border-radius: 50%;
  background: var(--sp-ink-2, #aab3c0);
  transition: transform 0.15s ease, background-color 0.15s ease;
}
.sp-toggle.on { background-color: var(--sp-accent, #3D6B3D); border-color: transparent; }
.sp-toggle.on .sp-toggle-thumb { transform: translateX(16px); background: #fff; }
.sp-toggle.disabled { opacity: 0.45; cursor: not-allowed; }
.sp-toggle.sp-toggle-overridden { border-style: dashed; opacity: 0.7; }
```

Class names `.on`/`.disabled` verified against `NotificationsSection.js:541-560` (exact match); the JSX also emits a third state class `sp-toggle-overridden` (admin-forced channel), styled above as dashed+dimmed so the override state is visible too. Use the `sp-` accent var names actually present in `index.css`.

- [ ] **Step 2: verify.** `npm run mobile:check -- --only staff-account-notifications`; eyeball on/off/disabled states in both skins. Commit.

### Task B6: proposal chalkboard import, /apply header, includes helper, blog fallback, potion rail

Five unrelated small fixes batched as one task; commit each as its OWN in-lane checkpoint (chalkboard, header, helper+consumers, blog, rail) so any one can be surgically reverted before the squash.

**Files:**
- Modify: `client/src/pages/proposal/proposalView/styles.js`, `client/src/index.css`, `client/src/pages/public/Blog.js`, `client/src/pages/plan/PotionPlanningLab.js`, `client/src/pages/public/portal/tabs/PrescriptionTab.js` (+ its test), `client/src/pages/proposal/proposalView/ProposalView.js`, `client/src/pages/admin/ProposalDetail.js`, `client/src/pages/admin/EventDetailPage.js`
- Create: `client/src/utils/packageIncludes.js`, `client/src/utils/packageIncludes.test.js`

- [ ] **Step 1: chalkboard.** In `styles.js`: `import chalkboardBg from '../../../images/chalkboard_background.png';` and replace line ~16's dead URL with `` backgroundImage: `url(${chalkboardBg})` ``. Never copy the PNG into `public/`.

- [ ] **Step 2: /apply header.** In `index.css`:

```css
@media (max-width: 640px) {
  .site-header { padding: 0.75rem 1rem; flex-wrap: wrap; }
  .header-user { display: none; }
}
```

- [ ] **Step 3: includes helper.** `client/src/utils/packageIncludes.js` (extracted verbatim from `ProposalView.js:428-437`):

```js
// Replace dynamic placeholders in package_includes strings.
// Tokens: {hours}, {bartenders}, {bartenders_s}. Null ctx values leave the token untouched.
export function interpolatePackageIncludes(items, { durationHours, bartenders } = {}) {
  return (items || []).map((item) => {
    let text = item;
    if (durationHours != null) text = text.replace(/\{hours\}/g, durationHours);
    if (bartenders != null) {
      text = text.replace(/\{bartenders\}/g, bartenders);
      text = text.replace(/\{bartenders_s\}/g, bartenders !== 1 ? 's' : '');
    }
    return text;
  });
}
```

- [ ] **Step 4: failing test first.** `client/src/utils/packageIncludes.test.js`:

```js
import { interpolatePackageIncludes } from './packageIncludes';

test('interpolates bartenders, plural, hours', () => {
  expect(interpolatePackageIncludes(
    ['{bartenders} professional bartender{bartenders_s}', '{hours} hours of service'],
    { bartenders: 2, durationHours: 4 }
  )).toEqual(['2 professional bartenders', '4 hours of service']);
});

test('singular drops the s and null ctx leaves tokens', () => {
  expect(interpolatePackageIncludes(['{bartenders} bartender{bartenders_s}'], { bartenders: 1 }))
    .toEqual(['1 bartender']);
  expect(interpolatePackageIncludes(['{hours} hours'], {})).toEqual(['{hours} hours']);
});
```

Run `cd client && CI=true npx react-scripts test --watchAll=false src/utils/packageIncludes.test.js`; fails (module missing) before Step 3's file lands, passes after.

- [ ] **Step 5: wire all four consumers.** Replace the inline copies in `ProposalView.js:428-437`, `ProposalDetail.js:~326`, `EventDetailPage.js:~152` with the helper. For `PrescriptionTab.js:50-54`: the portal detail endpoint (`server/routes/clientPortal.js:67-97`) returns **no pricing snapshot**; the fields to map are `num_bartenders` and `event_duration_hours` from the tab's payload: `interpolatePackageIncludes(includes, { bartenders: focus.num_bartenders ?? undefined, durationHours: focus.event_duration_hours ?? undefined })` (adjust to the tab's actual prop name for the proposal object). Note: `num_bartenders` is the stored value and can differ from the engine-computed `staffing.actual` the proposal page uses; for the portal display that stored value is the right one available. If a value is absent pass undefined, tokens stay visible rather than rendering wrong numbers. Add one fixture row with tokens to `PrescriptionTab.test.js` asserting the rendered text is interpolated. All four call sites in one commit (cross-cutting rule), and run a `consistency-check` review agent over this specific diff before the lane merges (it is exactly the cross-cutting shape that agent exists for).

- [ ] **Step 6: blog fallback.** In `Blog.js:86-90` and `:126-129`: when `cover_image_url` is null, render `<div className="lab-cover-fallback" aria-hidden="true">⚗</div>` instead of the striped placeholder, with CSS: parchment background, centered ornament glyph, same aspect box as the image. (Deliberate small deviation from the spec's "reuse existing brand classes" wording: one purpose-named class using the existing brand tokens is cleaner than overloading an unrelated `lab-*` class.) Note for Dallas (not code): upload a cover image for the current featured post.

- [ ] **Step 7: potion rail.** In `PotionPlanningLab.js:936-940`: replace the bare text div with the counter plus the styled rail, one tick per queue entry plus confirmation:

```jsx
<div className="potion-progress-counter" style={{ fontVariantNumeric: 'lining-nums' }}>
  Step {progressStep} of {totalSteps}
</div>
<div className="potion-rail" aria-hidden="true">
  {Array.from({ length: totalSteps }, (_, i) => (
    <span key={i} className={`potion-rail-tick ${i + 1 < progressStep ? 'done' : ''} ${i + 1 === progressStep ? 'active' : ''}`} />
  ))}
</div>
```

(`.potion-rail` / `.potion-rail-tick.done/.active` and `.potion-progress-counter` already exist in `index.css`, search by selector; match the class contract exactly to what the CSS expects before committing.)

- [ ] **Step 8: verify lane.** Full `npm run mobile:check`; expect apply + proposal pages green, report metrics unchanged-or-better elsewhere; client test run for the two test files; `CI=true npx react-scripts build` clean. Squash-merge Lane B.

---

## Lane C: mobile-pricebar

### Task C1: extract PrescriptionCard

**Files:**
- Create: `client/src/pages/website/quoteWizard/PrescriptionCard.js`
- Modify: `client/src/pages/website/quoteWizard/QuoteWizard.js` (`.wz-price-card` inline JSX at ~`:731-772`)

- [ ] **Step 1:** Move the `.wz-price-card` JSX into `PrescriptionCard.js` as a pure presentational component taking the exact props the inline block reads today (inspect the block; expected: `preview`, `formData`/selections used for line labels). Render it from the sidebar exactly as before. No visual change; verify with `npm run mobile:check -- --only quote` screenshot diff plus a desktop eyeball. Commit.

### Task C2: WizardPriceBar + sidebar suppression

**Files:**
- Create: `client/src/pages/website/quoteWizard/WizardPriceBar.js`
- Modify: `client/src/pages/website/quoteWizard/QuoteWizard.js`, `client/src/index.css`

**Interfaces:**
- Consumes: `PrescriptionCard` (C1), `preview` state, `steps`/`step`, the existing Continue handler and the existing guarded submit (`handleSubmit`, `submitting`) from `QuoteWizard.js:796-806`.

- [ ] **Step 1: component.**

```jsx
import { useState, useEffect } from 'react';
import PrescriptionCard from './PrescriptionCard';
import { formatCurrency } from './helpers'; // same import QuoteWizard.js:19 uses

export default function WizardPriceBar({ preview, isFinalStep, submitting, onContinue, onSubmit, cardProps, hidden }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => {
    document.body.style.overflow = sheetOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [sheetOpen]);
  if (hidden) return null;
  return (
    <>
      {sheetOpen && (
        <div className="wz-pricebar-sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <div className="wz-pricebar-sheet" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="wz-pricebar-sheet-close" onClick={() => setSheetOpen(false)}>Close</button>
            <PrescriptionCard {...cardProps} />
          </div>
        </div>
      )}
      <div className="wz-pricebar">
        {preview ? (
          <button type="button" className="wz-pricebar-price" onClick={() => setSheetOpen(true)}>
            The Prescription · {formatCurrency(preview.total)}
          </button>
        ) : <span />}
        {isFinalStep ? (
          <button type="button" className="btn-primary wz-pricebar-cta" onClick={onSubmit} disabled={submitting}>
            {submitting ? 'Submitting...' : 'Send proposal · See my quote'}
          </button>
        ) : (
          <button type="button" className="btn-primary wz-pricebar-cta" onClick={onContinue}>Continue →</button>
        )}
      </div>
    </>
  );
}
```

Load-bearing: `onSubmit` is the SAME `handleSubmit` used by the in-flow button and `submitting` the same guard; never a second handler (double-tap would create duplicate proposals and leads).

- [ ] **Step 2: wiring in QuoteWizard.** Render `<WizardPriceBar>` at the end of the wizard section. Keyboard hide: track focus with `onFocusCapture`/`onBlurCapture` on the form region setting `inputFocused`; pass `hidden={inputFocused}`. Mobile detection by CSS only: the bar is `display: none` above 900px, and at 900px and below the in-flow sidebar wrapper gets `display: none` while the in-flow Continue/submit inside `.wz-nav` is hidden (Back stays). The `FormBanner` keeps rendering in flow; clearance comes from padding on the section around `.wz-nav`.

- [ ] **Step 3: CSS.**

```css
.wz-pricebar {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  display: none;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
  background: rgba(18, 22, 28, 0.97);
  border-top: 1px solid rgba(184, 146, 74, 0.4);
  z-index: var(--z-sticky);
}
.wz-pricebar-price { background: none; border: none; color: var(--parchment); font-family: var(--font-display); font-size: 1rem; padding: 10px 4px; cursor: pointer; }
.wz-pricebar-cta { min-height: 44px; }
.wz-pricebar-sheet-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: var(--z-overlay); display: flex; align-items: flex-end; }
.wz-pricebar-sheet { width: 100%; max-height: 75vh; overflow-y: auto; background: var(--card-bg); border-radius: 12px 12px 0 0; padding: 16px; }
.wz-pricebar-sheet-close { float: right; }
@media (max-width: 900px) {
  .wz-pricebar { display: flex; }
  .wz-sidebar { display: none; }
  .wz-nav .btn-primary { display: none; }        /* Continue/submit move to the bar; Back stays */
  .wz-section-quote-bottom { padding-bottom: 84px; }  /* clearance for banner + nav above the fixed bar; apply to the wrapper that contains FormBanner and .wz-nav */
}
```

(Adjust the last selector to the actual wrapper element around `FormBanner`/`.wz-nav`; add the class to that wrapper in JSX if none exists.)

- [ ] **Step 4: verify.** `npm run mobile:check -- --only quote` plus a driven pass (reuse the audit's flow: fill step I, walk to review) confirming: no price on steps I-II left side, price appears from package step, sheet opens/closes, banner visible above the bar on a validation error, final step shows the guarded submit label. Manual phone walk before merge per spec (keyboard hide/show on the contact step, double-tap on submit). Desktop 1200px eyeball: sidebar unchanged, no bar. Then one ui-ux screenshot review pass over the new bar/sheet states (it is a new interactive component on the #1 conversion surface). Commit; squash-merge after C3.

### Task C3: scroll-to-first-error on the three long forms

**Files:** Modify: `client/src/pages/Application.js`, `client/src/pages/Agreement.js`, `client/src/pages/ContractorProfile.js`

- [ ] **Step 1:** In each submit handler's validation-failure branch (Application's handler starts ~`:132`):

```js
setTimeout(() => {
  const bad = document.querySelector('[aria-invalid="true"]');
  if (bad) { bad.scrollIntoView({ behavior: 'smooth', block: 'center' }); bad.focus({ preventScroll: true }); }
}, 0);
```

(`setTimeout` lets React commit the `aria-invalid` flips before querying.) All three pages already render `aria-invalid`.

- [ ] **Step 2: verify.** On `/apply` at 390px, submit empty, confirm the viewport lands on the first invalid field. Squash-merge Lane C.

---

## Lane D: mobile-sweep

One lane, grouped commits by surface. Every row shows the exact change; locate selectors by name.

### Task D1: marketing + wizard + potion + portal CSS sweep

**Files:** Modify: `client/src/index.css`, `client/src/pages/public/portal/ShareButton.js` (className only if needed)

| Where (selector, locate by name) | Change |
|---|---|
| `.ws-footer-col a` | `display: inline-block; padding: 10px 0;` and reduce the parent `ul` gap to 2px |
| Office column links (same footer block) | same treatment |
| `.ws-utility-link` | `display: inline-block; padding: 8px 6px;` |
| `.ws-menu-toggle` | `min-width: 44px; min-height: 44px;` |
| `.ws-mobile-drawer .ws-nav-cta` | `justify-content: center;` and delete the inert `text-align: center` |
| `.wz-tile-info` | `min-width: 36px; min-height: 36px;` (visual glyph unchanged, pad the hit area) |
| `.wz-skip-inline` | `padding: 10px 14px; min-height: 40px;` |
| TimePicker/NumberStepper arrows (`index.css` blocks near `:10188`, `:10328`) | under `@media (pointer: coarse)`: button height >= 36px |
| `.wz-nav .btn-secondary` (+ `:hover`) | `color: var(--cream-text); border-color: rgba(184, 146, 74, 0.5);` hover: faint brass fill |
| `.your-menu-extra-tag.removable` | `min-height: 32px;` padded remove target `min-width: 28px` |
| `.drink-card-list` | `padding-bottom: 72px;` |
| `.extra-source-badge`, potion badges at 0.65rem | 0.7rem floor |
| `.potion-save.saved` | opacity/color to ~0.7 parchment |
| `.cp-receipt-row .client-btn-outline` | `color: var(--deep-brown); border-color: rgba(28, 22, 16, 0.4);` inverted hover |
| `.cp-share-hint` in dark actions row | raise to 0.8 opacity |
| Portal/staff/invoice 11px labels (`.cp-*` money labels, `.invoice-*` per spec list) | floor at 12px: `.invoice-brand-sub` 9px -> 12px, `.invoice-notes`/`.invoice-actions-footnote` -> 12px, `.invoice-meta-label`/`.invoice-table th` -> 12px |
| `.invoice-table` wrapper | wrap the table element in `<div className="invoice-table-wrap">` with `overflow-x: auto;` and `white-space: nowrap` on price/total cells (needs a 2-line JSX touch in `InvoicePage.js`; include that file in the commit) |
| `.invoice-meta-line` | `overflow-wrap: anywhere;` |
| `.proposal-layout` (the copy near `:9521` used by the public view) | rename to `.proposal-view-layout` here and in `ProposalView.js:498` |

- [ ] Apply, then `npm run mobile:check` full run: zero new FAILs, and on the touched pages the `tinyText` count reaches 0 and `smallTaps` drops to at most the known leftovers (record both against the Lane A baseline numbers in the checkpoint message; any touched selector still counted means the fix missed). Commit.

### Task D2: staff portal sweep

**Files:** Modify: `client/src/index.css`, `client/src/pages/staff/ShiftsPage.js`

| Where | Change |
|---|---|
| `ShiftsPage.js:~471-473` Request button | `sp-btn-sm` -> `sp-btn` |
| `.sp-tf-input`, `.sp-pm-input`, `.sp-modal-input` | `font-size: 16px;` (kills real iOS zoom) |
| `.sp-tf-k`, `.sp-tf-sub`, `.sp-subsection` | 12px floor, helper tone `--sp-ink-2` |
| `.sp-shift-when`, `.sp-shift-rel`, `.sp-shift-roster-fill`, `.sp-chip` | 12px floor; meta rows promoted from `--sp-ink-4` to `--sp-ink-3`/`--sp-ink-2` |

- [ ] `npm run mobile:check -- --only staff-shifts,staff-account-profile,staff-account-payments`; `tinyText` on these pages reaches 0 and `smallTaps` at most the known leftovers vs the Lane A baseline (record both), no FAILs. Commit.

### Task D3: sign-and-pay page (focused-review scope)

**Files:** Modify: `client/src/pages/proposal/proposalView/PaymentForm.js`, `client/src/pages/proposal/proposalView/SignAndPaySection.js`, `client/src/pages/proposal/proposalView/styles.js`, `client/src/components/SignaturePad.js`, `client/src/index.css`

- [ ] **Step 1: Stripe skeleton, overlay-not-replace.** In `PaymentForm.js`: add `const [elementReady, setElementReady] = useState(false);` and `const [revealAnyway, setRevealAnyway] = useState(false);` with `useEffect(() => { const t = setTimeout(() => setRevealAnyway(true), 10000); return () => clearTimeout(t); }, []);`. Render `<PaymentElement onReady={() => setElementReady(true)} />` ALWAYS MOUNTED inside a relatively positioned wrap; while `!elementReady && !revealAnyway`, render an absolutely positioned skeleton overlay on top ("Loading secure payment...", parchment pulse). CSS: `.sign-pay-stripe-wrap { min-height: 180px; position: relative; }` plus the overlay class. The `loadingIntent` spinner and `!activeSecret` fallback in `SignAndPaySection.js` (`:95`, `:117`, `:405`) stay untouched.

- [ ] **Step 2: disabled pay button.** In `styles.js` `payButton` disabled overlay (used at `PaymentForm.js:55-60`): replace `opacity: 0.45, filter: grayscale(0.7)` with `backgroundColor: '#B8AD98', color: '#3A2E1E', boxShadow: 'none', cursor: 'not-allowed'`. Style only; the `disabled` condition at `PaymentForm.js:54` (`!stripe || paying || disabled`) is untouched.

- [ ] **Step 3: SignaturePad DPR.** In the resize routine (`SignaturePad.js:38-44`): set `canvas.width = rect.width * dpr; canvas.height = 140 * dpr;` keep CSS size via `canvas.style.width/height`, and re-apply `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` after EVERY width set (setting width resets the transform). Preserve the existing stroke-restore behavior if the pad redraws on resize. Mode/Accept/Clear buttons to min-height 40px in CSS.

- [ ] **Step 4: verify.** `npm run mobile:check -- --only proposal-sent,proposal-paid,invoice`; manual: real phone (or devtools DPR 3 emulation minimum) draw a signature and confirm stroke alignment and crisp capture, block Stripe via devtools request blocking and confirm the 10s reveal shows the element area unmasked. Spec requires an actual signing on a high-DPR phone before merge. **Focused reviewer on this task's diff before the lane merges.**

- [ ] **Step 5: lane close.** Full `npm run mobile:check` (goal: zero FAILs, tap/tiny counts near zero), `CI=true npx react-scripts build`, squash-merge Lane D.

---

## Self-review notes (done at write time)

- Spec coverage walked section by section: every Lane 0-3 spec item maps to a task above (harness gate A1; strips B1; stepper B2; onboarding B3; skin B4; toggles B5; chalkboard, /apply, includes, blog, rail B6; card extract C1; price bar C2; scroll-to-error C3; sweep tables D1-D2; sign-and-pay D3). Out-of-scope list unchanged.
- The `sp-toggle` state-class names (`.on`, `.disabled`) must be verified against `NotificationsSection.js` JSX before writing CSS; B5 says so explicitly.
- Line anchors above index.css ~12000 are drifted; every CSS instruction here names selectors.
